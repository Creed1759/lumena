import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  WebhookConfig,
  WebhookEventType,
  WebhookPayload,
  WebhookDeliveryResult,
  WebhookDeliveryLogEntry,
} from "@lumen/types";
import { logger } from "../logger.js";

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const digest = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    return false;
  }

  const receivedDigest = Buffer.from(digest, "hex");
  const expectedDigest = createHmac("sha256", secret).update(payload).digest();
  return (
    receivedDigest.length === expectedDigest.length &&
    timingSafeEqual(receivedDigest, expectedDigest)
  );
}

export interface WebhookDispatcherOpts {
  webhooks?: WebhookConfig[];
  timeoutMs?: number;
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  deliveryLogPath?: string;
}

export class WebhookDispatcher {
  private webhooks: Map<string, WebhookConfig> = new Map();
  private timeoutMs: number;
  private maxRetries: number;
  private initialDelayMs: number;
  private backoffFactor: number;
  private readonly deliveryLogPath: string;
  private deliveryLogWrite: Promise<void> = Promise.resolve();

  constructor(opts: WebhookDispatcherOpts = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.initialDelayMs = opts.initialDelayMs ?? 200;
    this.backoffFactor = opts.backoffFactor ?? 2;
    this.deliveryLogPath =
      opts.deliveryLogPath ??
      process.env.LUMEN_WEBHOOK_DELIVERY_LOG_PATH ??
      path.join(process.cwd(), "data", "webhook-deliveries.jsonl");

    if (opts.webhooks) {
      for (const wh of opts.webhooks) {
        this.register(wh);
      }
    }
  }

  register(config: WebhookConfig): void {
    this.webhooks.set(config.id, {
      ...config,
      enabled: config.enabled ?? true,
    });
  }

  unregister(id: string): boolean {
    return this.webhooks.delete(id);
  }

  get(id: string): WebhookConfig | undefined {
    return this.webhooks.get(id);
  }

  list(): WebhookConfig[] {
    return Array.from(this.webhooks.values());
  }

  /**
   * Partially update an existing webhook registration.
   * Returns the updated `WebhookConfig`, or `null` if the id is not found.
   */
  update(id: string, updates: Partial<Omit<WebhookConfig, "id">>): WebhookConfig | null {
    const existing = this.webhooks.get(id);
    if (!existing) return null;
    const updated: WebhookConfig = { ...existing, ...updates, id };
    this.webhooks.set(id, updated);
    return updated;
  }

  /**
   * Dispatch a synthetic `test.ping` event to a specific webhook by id.
   * Returns a delivery summary describing the single attempt.
   */
  async sendTest(id: string): Promise<{
    success: boolean;
    statusCode?: number;
    attempts: number;
    responseTimeMs: number;
  }> {
    const wh = this.webhooks.get(id);
    if (!wh) throw new Error(`Webhook not found: ${id}`);

    const payload = {
      id: randomUUID(),
      event: "test.ping" as WebhookEventType,
      timestamp: new Date().toISOString(),
      data: { message: "This is a test delivery from the Lumen webhook system." },
    };
    const body = JSON.stringify(payload);
    const signature = this.generateSignature(body, wh.secret);

    const startTime = Date.now();
    let statusCode: number | undefined;
    let success = false;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const res = await fetch(wh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lumen-Signature": signature,
          "X-Lumen-Event": "test.ping",
          "X-Lumen-Delivery": payload.id,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      statusCode = res.status;
      success = res.ok;
    } catch {
      success = false;
    }

    const responseTimeMs = Date.now() - startTime;
    return { success, statusCode, attempts: 1, responseTimeMs };
  }

  async getDeliveryLog(): Promise<WebhookDeliveryLogEntry[]> {
    let contents: string;
    try {
      contents = await fs.promises.readFile(this.deliveryLogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    return contents
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as WebhookDeliveryLogEntry);
  }

  private async persistDeliveryLog(entries: WebhookDeliveryLogEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const write = this.deliveryLogWrite.then(async () => {
      await fs.promises.mkdir(path.dirname(this.deliveryLogPath), {
        recursive: true,
        mode: 0o700,
      });
      const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
      await fs.promises.appendFile(this.deliveryLogPath, `${lines}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    });
    this.deliveryLogWrite = write.catch((error: unknown) => {
      logger.error({ error }, "Failed to persist webhook delivery log");
    });
    await write;
  }

  generateSignature(payload: string, secret: string): string {
    const hmac = createHmac("sha256", secret);
    hmac.update(payload);
    return `sha256=${hmac.digest("hex")}`;
  }

  createPayload<T>(event: WebhookEventType, data: T): WebhookPayload<T> {
    return {
      id: randomUUID(),
      event,
      timestamp: new Date().toISOString(),
      data,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async dispatch<T>(event: WebhookEventType, data: T): Promise<WebhookDeliveryResult[]> {
    const matchingWebhooks = Array.from(this.webhooks.values()).filter(
      (wh) => wh.enabled !== false && (wh.events.includes(event) || wh.events.includes("*")),
    );

    if (matchingWebhooks.length === 0) {
      return [];
    }

    const payload = this.createPayload(event, data);
    const body = JSON.stringify(payload);

    const deliveryPromises = matchingWebhooks.map(async (wh) => {
      const signature = this.generateSignature(body, wh.secret);
      let attempts = 0;
      let lastStatusCode: number | undefined;
      let lastError: string | undefined;
      let success = false;

      while (attempts <= this.maxRetries) {
        attempts++;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), this.timeoutMs);

          const res = await fetch(wh.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Lumen-Signature": signature,
              "X-Lumen-Event": event,
              "X-Lumen-Delivery": payload.id,
            },
            body,
            signal: controller.signal,
          });

          clearTimeout(timer);
          lastStatusCode = res.status;

          if (res.ok) {
            success = true;
            break;
          }

          // If client error (other than 429 Too Many Requests), do not retry
          if (res.status >= 400 && res.status < 500 && res.status !== 429) {
            lastError = `HTTP ${res.status}: ${res.statusText}`;
            break;
          }

          lastError = `HTTP ${res.status}: ${res.statusText}`;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
        }

        if (attempts <= this.maxRetries) {
          const delay = this.initialDelayMs * Math.pow(this.backoffFactor, attempts - 1);
          await this.sleep(delay);
        }
      }

      if (!success) {
        logger.warn(
          { webhookId: wh.id, attempts, error: lastError },
          "Webhook delivery failed after attempts",
        );
      }

      return {
        webhookId: wh.id,
        url: wh.url,
        success,
        statusCode: lastStatusCode,
        attempts,
        error: success ? undefined : lastError,
      } as WebhookDeliveryResult;
    });

    const results = await Promise.all(deliveryPromises);
    const deliveredAt = new Date().toISOString();
    await this.persistDeliveryLog(
      results.map((result) => ({
        ...result,
        deliveryId: payload.id,
        event,
        timestamp: payload.timestamp,
        deliveredAt,
        data: payload.data,
      })),
    );

    return results;
  }
}
