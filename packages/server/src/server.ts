import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors, { type CorsOptions } from "cors";
import rateLimit from "express-rate-limit";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type RequestListener,
  type IncomingMessage,
} from "node:http";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarClient } from "@lumen/core";
import type { Signer } from "@lumen/types";
import type { WalletRegistry } from "@lumen/core";
import { CosignerService } from "./cosigner/service.js";
import { FeeSponsorService } from "./fee-sponsor/service.js";
import { PolicyEngine } from "./policy/engine.js";
import {
  CosignRequestSchema,
  FeeBumpRequestSchema,
  PolicyRequestSchema,
  WebhookRequestSchema,
  WebhookPatchSchema,
} from "./validation.js";
import swaggerUi from "swagger-ui-express";
import { openApiSpec } from "./openapi.js";
import { ValidationError, PolicyError, errorHandler, wrapHandler } from "./errors.js";
import { logger, httpLogger } from "./logger.js";
import {
  register,
  cosignRequestsTotal,
  feeBumpRequestsTotal,
  policyEvaluationDurationSeconds,
} from "./metrics.js";

import { SponsorMonitorService } from "./fee-sponsor/monitor.js";
import { WebhookDispatcher } from "./webhook/dispatcher.js";

export interface ServerResult {
  /** Configured Express application. */
  app: Express;
  /** Node HTTP server wrapping the Express application. */
  server: HttpServer;
  /** Stellar/Horizon/RPC client used by server services. */
  client: StellarClient;
  cosignerService: CosignerService;
  feeSponsorService: FeeSponsorService;
  sponsorMonitorService: SponsorMonitorService;
  policyEngine: PolicyEngine;
  webhookDispatcher: WebhookDispatcher;
}

export interface ServerOpts {
  /** Port used by the HTTP server. Defaults to 3000. */
  port?: number;
  /** Stellar network preset used for Horizon/RPC defaults. */
  network?: "testnet" | "mainnet" | "local";
  horizonUrl?: string;
  rpcUrl?: string;
  /**
   * Signer used by the co-signer service.
   * Dev/testnet → EnvSigner.  Production → AwsKmsSigner or equivalent.
   */
  cosignerSigner: Signer;
  /**
   * Signer used by the fee-sponsor service.
   * Dev/testnet → EnvSigner.  Production → AwsKmsSigner or equivalent.
   */
  feePayerSigner: Signer;
  minSponsorBalance?: number;
  sponsorPollIntervalMs?: number;
  webhookDispatcher?: WebhookDispatcher;
  /**
   * Optional CORS configuration passed to the `cors` npm package.
   * Cross-origin access is disabled by default.
   */
  cors?: CorsOptions;
  /**
   * Optional PolicyEngine instance.
   */
  policyEngine?: PolicyEngine;
  /**
   * Optional API key to protect server endpoints.
   * When set, requires 'Authorization: Bearer <api-key>' on all routes except /health and /metrics.
   */
  apiKey?: string;
  /**
   * Rate limiting window in milliseconds for /cosign and /fee-bump endpoints.
   */
  windowMs?: number;
  /**
   * Maximum requests allowed within windowMs for /cosign and /fee-bump endpoints.
   */
  max?: number;
  /**
   * Rate limit options for /cosign and /fee-bump endpoints.
   */
  rateLimit?: {
    windowMs?: number;
    max?: number;
  };
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  /**
   * Optional WalletRegistry to persist and list registered wallet addresses.
   * When provided, POST /wallet/create registers the new wallet and
   * GET /wallets lists all registered wallets.
   */
  walletRegistry?: WalletRegistry;
}

/** Creates the Lumen API server, service graph, and policy engine. */
export function createServer(opts: ServerOpts): ServerResult {
  const port = opts.port ?? 3000;

  const client = new StellarClient({
    network: opts.network,
    horizonUrl: opts.horizonUrl,
    rpcUrl: opts.rpcUrl,
  });

  const policyEngine = opts.policyEngine ?? new PolicyEngine();
  const webhookDispatcher = opts.webhookDispatcher ?? new WebhookDispatcher();

  const cosignerService = new CosignerService({
    client,
    signer: opts.cosignerSigner,
    policyEngine,
    webhookDispatcher,
  });

  const feeSponsorService = new FeeSponsorService({
    client,
    signer: opts.feePayerSigner,
    webhookDispatcher,
  });

  const sponsorMonitorService = new SponsorMonitorService({
    client,
    sponsorPublicKey: opts.feePayerSigner.publicKey(),
    minBalanceXlm: opts.minSponsorBalance,
    pollIntervalMs: opts.sponsorPollIntervalMs,
    webhookDispatcher,
  });

  const app = express();
  app.use((req, res, next) => {
    httpLogger(req as unknown as IncomingMessage, res, next);
  });
  app.use(express.json());

  const corsOptions: CorsOptions = opts.cors ?? { origin: false };
  app.use(cors(corsOptions));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.id) {
      res.setHeader("x-request-id", req.id as string);
    }
    next();
  });

  // API Key Authentication Middleware
  if (opts.apiKey) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const cleanPath = (req.path || "").replace(/\/+$/, "") || "/";
      if (cleanPath === "/health" || cleanPath === "/metrics") {
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer" || parts[1] !== opts.apiKey) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      next();
    });
  }

  // Rate Limiting Middleware for /cosign and /fee-bump
  const rateLimitWindowMs =
    opts.rateLimit?.windowMs ?? opts.rateLimitWindowMs ?? opts.windowMs ?? 60 * 1000;
  const rateLimitMax = opts.rateLimit?.max ?? opts.rateLimitMax ?? opts.max ?? 100;

  const cosignFeeBumpLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    limit: rateLimitMax,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    statusCode: 429,
    message: { error: "Too Many Requests" },
  });

  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiSpec));

  let activeRequests = 0;

  app.use((_req: Request, _res: Response, next: NextFunction) => {
    activeRequests++;
    _res.on("finish", () => {
      activeRequests--;
    });
    next();
  });

  app.get(
    "/health",
    wrapHandler(async (_req, res) => {
      let horizonConnected = false;
      try {
        await client.horizon.root();
        horizonConnected = true;
      } catch {
        horizonConnected = false;
      }

      res.json({
        status: "ok",
        horizonConnected,
        network: client.config.network,
        version: "0.1.0",
      });
    }),
  );

  app.get(
    "/metrics",
    wrapHandler(async (_req: Request, res: Response) => {
      res.setHeader("Content-Type", register.contentType);
      res.send(await register.metrics());
    }),
  );

  app.get(
    "/sponsor/status",
    wrapHandler(async (_req: Request, res: Response) => {
      const status = await sponsorMonitorService.checkBalance();
      res.json(status);
    }),
  );

  app.post(
    "/cosign",
    cosignFeeBumpLimiter,
    wrapHandler(async (req: Request, res: Response) => {
      const timer = policyEvaluationDurationSeconds.startTimer();
      try {
        const parsed = CosignRequestSchema.safeParse(req.body);
        if (!parsed.success) {
          cosignRequestsTotal.inc({ status: "rejected" });
          throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
        }

        const result = await cosignerService.cosign(parsed.data);

        if (!result.approved) {
          cosignRequestsTotal.inc({ status: "rejected" });
          throw new PolicyError(result.reason ?? "Transaction denied by policy");
        }

        cosignRequestsTotal.inc({ status: "approved" });
        res.json({ signedXdr: result.signedXdr });
      } catch (err) {
        if (!(err instanceof ValidationError) && !(err instanceof PolicyError)) {
          cosignRequestsTotal.inc({ status: "rejected" });
        }
        throw err;
      } finally {
        timer();
      }
    }),
  );

  app.post(
    "/fee-bump",
    cosignFeeBumpLimiter,
    wrapHandler(async (req: Request, res: Response) => {
      feeBumpRequestsTotal.inc();
      const parsed = FeeBumpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const feeBumpXdr = await feeSponsorService.wrapFeeBump(parsed.data.xdr);
      res.json({ feeBumpXdr });
    }),
  );

  app.post(
    "/fee-bump/submit",
    cosignFeeBumpLimiter,
    wrapHandler(async (req: Request, res: Response) => {
      feeBumpRequestsTotal.inc();
      const parsed = FeeBumpRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const result = await feeSponsorService.submit(parsed.data.xdr);
      res.json(result);
    }),
  );

  app.get("/policy/:walletId", (req: Request, res: Response) => {
    const policy = policyEngine.getPolicy(req.params.walletId as string);
    if (!policy) {
      throw new PolicyError("No policy found", 404);
    }
    res.json(policy);
  });

  app.post(
    "/policy",
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = PolicyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      if (policyEngine.getPolicy(parsed.data.walletId)) {
        throw new PolicyError("A policy already exists for this wallet", 409);
      }

      const policy = {
        id: crypto.randomUUID(),
        walletId: parsed.data.walletId,
        rules: parsed.data.rules,
        createdAt: new Date(),
      };

      policyEngine.addPolicy(policy);
      res.status(201).json(policy);
    }),
  );

  app.put(
    "/policy/:walletId",
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = PolicyRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const walletId = req.params.walletId as string;
      if (parsed.data.walletId !== walletId) {
        throw new ValidationError("walletId in the request body must match the URL");
      }

      const existingPolicy = policyEngine.getPolicy(walletId);
      if (!existingPolicy) {
        throw new PolicyError("No policy found", 404);
      }

      const policy = {
        ...existingPolicy,
        rules: parsed.data.rules,
      };

      policyEngine.addPolicy(policy);
      res.json(policy);
    }),
  );

  app.delete("/policy/:walletId", (req: Request, res: Response) => {
    const walletId = req.params.walletId as string;
    if (!policyEngine.getPolicy(walletId)) {
      throw new PolicyError("No policy found", 404);
    }

    policyEngine.removePolicy(walletId);
    res.status(204).send();
  });

  app.post(
    "/wallet/create",
    wrapHandler(async (req: Request, res: Response) => {
      const { Wallet } = await import("@lumen/core");

      const sponsorKeypair = Keypair.fromPublicKey(opts.cosignerSigner.publicKey());
      const wallet = new Wallet({
        client,
        sponsorKeypair,
        serverPublicKey: opts.cosignerSigner.publicKey(),
      });

      const result = await wallet.create();

      // Register the new wallet address if a registry is configured
      if (opts.walletRegistry) {
        await opts.walletRegistry.register(result.address);
      }

      void webhookDispatcher
        .dispatch("wallet.created", {
          address: result.address,
          publicKey: result.publicKey,
        })
        .catch((error: unknown) => {
          logger.error({ error }, "Failed to dispatch wallet.created webhook");
        });
      res.json({ address: result.address, publicKey: result.publicKey });
    }),
  );

  // #169 — GET /wallets: list all registered wallets
  app.get(
    "/wallets",
    wrapHandler(async (req: Request, res: Response) => {
      if (!opts.walletRegistry) {
        res.json({ wallets: [], total: 0 });
        return;
      }

      const allWallets = await opts.walletRegistry.list();

      const limitParam = req.query.limit;
      const offsetParam = req.query.offset;

      const limit = limitParam === undefined ? 50 : Math.max(1, Math.min(200, Number(limitParam)));
      const offset = offsetParam === undefined ? 0 : Math.max(0, Number(offsetParam));

      const paginated = allWallets.slice(offset, offset + limit);

      res.json({ wallets: paginated, total: allWallets.length });
    }),
  );

  // #170 — GET /policy: list all configured policies
  app.get(
    "/policy",
    wrapHandler(async (_req: Request, res: Response) => {
      const policies = policyEngine.listPolicies();
      res.json({ policies, count: policies.length });
    }),
  );

  app.get(
    "/wallet/:address/transactions",
    wrapHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new ValidationError("address must be a valid Stellar public key");
      }

      const limitParam = req.query.limit;
      const limit = limitParam === undefined ? 20 : Number(limitParam);
      if (
        (limitParam !== undefined && typeof limitParam !== "string") ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200
      ) {
        throw new ValidationError("limit must be an integer between 1 and 200");
      }

      const cursorParam = req.query.cursor;
      if (cursorParam !== undefined && typeof cursorParam !== "string") {
        throw new ValidationError("cursor must be a string");
      }

      let transactions = client.horizon
        .transactions()
        .forAccount(address)
        .order("desc")
        .limit(limit);
      if (cursorParam) {
        transactions = transactions.cursor(cursorParam);
      }
      const page = await transactions.call();
      const records = page.records;
      res.json({
        address,
        transactions: records,
        nextCursor: records.at(-1)?.paging_token ?? null,
      });
    }),
  );

  app.get(
    "/wallet/:address/balance",
    wrapHandler(async (req: Request, res: Response) => {
      const address = req.params.address as string;
      if (!StrKey.isValidEd25519PublicKey(address)) {
        throw new ValidationError("address must be a valid Stellar public key");
      }

      const account = await client.horizon.loadAccount(address);
      res.json({ address, balances: account.balances });
    }),
  );

  app.post(
    "/webhooks",
    wrapHandler(async (req: Request, res: Response) => {
      const parsed = WebhookRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }
      const { id: bodyId, url, secret, events, enabled } = parsed.data;
      const id = bodyId ?? crypto.randomUUID();
      webhookDispatcher.register({ id, url, secret, events, enabled: enabled ?? true });
      res.status(201).json({ id, url, events, enabled: enabled ?? true });
    }),
  );

  app.get("/webhooks", (_req: Request, res: Response) => {
    res.json(webhookDispatcher.list().map(({ secret: _secret, ...rest }) => rest));
  });

  app.delete("/webhooks/:id", (req: Request, res: Response) => {
    const deleted = webhookDispatcher.unregister(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.status(204).send();
  });

  app.patch(
    "/webhooks/:id",
    wrapHandler(async (req: Request, res: Response) => {
      const id = req.params.id as string;

      const parsed = WebhookPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Validation failed", parsed.error.flatten().fieldErrors);
      }

      const updated = webhookDispatcher.update(id, parsed.data);
      if (!updated) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      const { secret: _secret, ...safeConfig } = updated;
      res.json(safeConfig);
    }),
  );

  app.post(
    "/webhooks/:id/test",
    wrapHandler(async (req: Request, res: Response) => {
      const id = req.params.id as string;

      if (!webhookDispatcher.get(id)) {
        res.status(404).json({ error: "Webhook not found" });
        return;
      }

      const result = await webhookDispatcher.sendTest(id);
      res.json({
        success: result.success,
        statusCode: result.statusCode ?? null,
        attempts: result.attempts,
        responseTimeMs: result.responseTimeMs,
      });
    }),
  );

  app.get(
    "/webhooks/deliveries",
    wrapHandler(async (_req: Request, res: Response) => {
      res.json(await webhookDispatcher.getDeliveryLog());
    }),
  );

  app.use(errorHandler);

  const server = createHttpServer(app as unknown as RequestListener);

  server.listen(port, () => {
    logger.info({ port, network: client.config.network }, `Lumen server listening on port ${port}`);
    logger.info(
      { cosigner: opts.cosignerSigner.publicKey(), feePayer: opts.feePayerSigner.publicKey() },
      "Signer addresses initialized",
    );
  });

  const gracefulShutdown = (signal: string) => {
    logger.info({ signal }, `${signal} received, shutting down gracefully`);
    sponsorMonitorService.stop();

    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });

    const timeout = setTimeout(() => {
      logger.error("Forced shutdown after timeout");
      process.exit(1);
    }, 30000);

    const checkInterval = setInterval(() => {
      if (activeRequests === 0) {
        clearInterval(checkInterval);
        clearTimeout(timeout);
        server.close(() => {
          logger.info("HTTP server closed");
          process.exit(0);
        });
      }
    }, 100);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  return {
    app,
    server,
    client,
    cosignerService,
    feeSponsorService,
    sponsorMonitorService,
    policyEngine,
    webhookDispatcher,
  };
}
