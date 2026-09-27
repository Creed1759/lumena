import type { StellarClient } from "@lumen/core";
import { logger } from "../logger.js";
import { sponsorBalanceXlm } from "../metrics.js";
import type { WebhookDispatcher } from "../webhook/dispatcher.js";

export interface SponsorMonitorOpts {
  client: StellarClient;
  sponsorPublicKey: string;
  minBalanceXlm?: number;
  pollIntervalMs?: number;
  onLowBalance?: (balance: number, threshold: number) => void | Promise<void>;
  webhookUrl?: string;
  webhookDispatcher?: WebhookDispatcher;
}

export interface CheckBalanceResult {
  balance: number;
  isLow: boolean;
  threshold: number;
}

export class SponsorMonitorService {
  private client: StellarClient;
  private sponsorPublicKey: string;
  private minBalanceXlm: number;
  private pollIntervalMs: number;
  private onLowBalance?: (balance: number, threshold: number) => void | Promise<void>;
  private webhookUrl?: string;
  private webhookDispatcher?: WebhookDispatcher;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(opts: SponsorMonitorOpts) {
    this.client = opts.client;
    this.sponsorPublicKey = opts.sponsorPublicKey;

    const envMinBalance = process.env.SPONSOR_MIN_BALANCE
      ? parseFloat(process.env.SPONSOR_MIN_BALANCE)
      : undefined;
    this.minBalanceXlm = opts.minBalanceXlm ?? envMinBalance ?? 50;

    const envPollInterval = process.env.SPONSOR_POLL_INTERVAL_MS
      ? parseInt(process.env.SPONSOR_POLL_INTERVAL_MS, 10)
      : undefined;
    this.pollIntervalMs = opts.pollIntervalMs ?? envPollInterval ?? 60000;

    this.onLowBalance = opts.onLowBalance;
    this.webhookUrl = opts.webhookUrl ?? process.env.SPONSOR_ALERT_WEBHOOK_URL;
    this.webhookDispatcher = opts.webhookDispatcher;
  }

  get isRunning(): boolean {
    return this.intervalId !== null;
  }

  async checkBalance(): Promise<CheckBalanceResult> {
    try {
      const account = await this.client.horizon.loadAccount(this.sponsorPublicKey);
      const nativeBalanceLine = account.balances.find((b) => b.asset_type === "native");

      const balance = nativeBalanceLine ? parseFloat(nativeBalanceLine.balance) : 0;
      const isLow = balance < this.minBalanceXlm;

      sponsorBalanceXlm.set(balance);

      if (isLow) {
        logger.warn(
          { sponsorPublicKey: this.sponsorPublicKey, balance, minBalanceXlm: this.minBalanceXlm },
          `Sponsor account balance (${balance} XLM) is below minimum threshold (${this.minBalanceXlm} XLM)`,
        );

        if (this.onLowBalance) {
          try {
            await this.onLowBalance(balance, this.minBalanceXlm);
          } catch (err) {
            logger.error(
              { err },
              "[SponsorMonitorService] Error executing onLowBalance alert callback",
            );
          }
        }

        if (this.webhookUrl) {
          try {
            await fetch(this.webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "sponsor_low_balance",
                sponsorPublicKey: this.sponsorPublicKey,
                balance,
                threshold: this.minBalanceXlm,
                timestamp: new Date().toISOString(),
              }),
            });
          } catch (err) {
            logger.error({ err }, "[SponsorMonitorService] Failed to send webhook alert");
          }
        }

        if (this.webhookDispatcher) {
          try {
            await this.webhookDispatcher.dispatch("balance.low", {
              sponsorPublicKey: this.sponsorPublicKey,
              balance,
              threshold: this.minBalanceXlm,
            });
          } catch (err) {
            logger.error(
              { err },
              "[SponsorMonitorService] Failed to dispatch balance.low webhook event",
            );
          }
        }
      }

      return { balance, isLow, threshold: this.minBalanceXlm };
    } catch (error) {
      logger.error(
        { error, sponsorPublicKey: this.sponsorPublicKey },
        "[SponsorMonitorService] Error loading sponsor account",
      );
      throw error;
    }
  }

  start(): void {
    if (this.intervalId) return;

    // Trigger initial check asynchronously
    this.checkBalance().catch(() => {});

    this.intervalId = setInterval(() => {
      this.checkBalance().catch(() => {});
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
