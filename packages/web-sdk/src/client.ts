import { Keypair, Asset, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  StellarClient,
  Wallet,
  KNOWN_ASSETS,
  PasskeyManager,
  type PasskeyRegistrationOpts,
} from "@lumen/core";
import type { StellarNetwork, ContractSimulationResult, ScValInput } from "@lumen/types";

export interface LumenClientOpts {
  network?: StellarNetwork;
  horizonUrl?: string;
  rpcUrl?: string;
  serverUrl?: string;
  sponsorSecret: string;
  serverPublicKey: string;
}

export interface SessionKeyInfo {
  keypair: Keypair;
  publicKey: string;
  secretKey: string;
  expiresAt: number;
}

export interface PasskeyWalletResult {
  address: string;
  id: string;
  credentialId: string;
  keypair: Keypair;
}

export function createSessionKey(durationSeconds: number = 3600): SessionKeyInfo {
  const keypair = Keypair.random();
  const expiresAt = Date.now() + durationSeconds * 1000;
  return {
    keypair,
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
    expiresAt,
  };
}

export class LumenClient {
  private client: StellarClient;
  private sponsorKeypair: Keypair;
  private serverPublicKey: string;
  private serverUrl?: string;
  private wallets: Map<string, Wallet> = new Map();

  constructor(opts: LumenClientOpts) {
    this.client = new StellarClient({
      network: opts.network,
      horizonUrl: opts.horizonUrl,
      rpcUrl: opts.rpcUrl,
    });
    this.sponsorKeypair = Keypair.fromSecret(opts.sponsorSecret);
    this.serverPublicKey = opts.serverPublicKey;
    this.serverUrl = opts.serverUrl;
  }

  createSessionKey(durationSeconds: number = 3600): SessionKeyInfo {
    return createSessionKey(durationSeconds);
  }

  async createWallet(): Promise<{ address: string; id: string }> {
    const wallet = new Wallet({
      client: this.client,
      sponsorKeypair: this.sponsorKeypair,
      serverPublicKey: this.serverPublicKey,
      serverUrl: this.serverUrl,
    });

    const { address } = await wallet.create();
    const id = address;

    this.wallets.set(id, wallet);

    return { address, id };
  }

  async createWalletWithPasskey(opts?: PasskeyRegistrationOpts): Promise<PasskeyWalletResult> {
    const passkeyManager = new PasskeyManager();
    const username = opts?.username ?? `user-${Date.now()}`;
    const { credentialId, keypair } = await passkeyManager.registerPasskey({
      username,
      rpName: opts?.rpName,
      challenge: opts?.challenge,
    });

    const wallet = new Wallet({
      client: this.client,
      sponsorKeypair: this.sponsorKeypair,
      serverPublicKey: this.serverPublicKey,
      serverUrl: this.serverUrl,
      ownerKeypair: keypair,
    });

    const { address } = await wallet.create();
    const id = address;
    this.wallets.set(id, wallet);

    return { address, id, credentialId, keypair };
  }

  async signWithPasskey(opts: {
    credentialId?: string;
    transactionXdr: string;
    username?: string;
  }): Promise<{ signedXdr: string; publicKey: string }> {
    const passkeyManager = new PasskeyManager();
    const { keypair } = await passkeyManager.authenticatePasskey({
      credentialId: opts.credentialId,
      username: opts.username,
    });

    const tx = TransactionBuilder.fromXDR(opts.transactionXdr, this.client.networkPassphrase);
    tx.sign(keypair);

    return {
      signedXdr: tx.toXDR(),
      publicKey: keypair.publicKey(),
    };
  }

  getWallet(id: string): Wallet | undefined {
    return this.wallets.get(id);
  }

  async getBalance(id: string, assetCode?: string): Promise<string> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    if (!assetCode || assetCode === "XLM") {
      return wallet.getBalance();
    }

    const network = this.client.config.network;
    const knownAsset = KNOWN_ASSETS[network]?.[assetCode];
    if (!knownAsset) {
      throw new Error(
        `Unknown asset: ${assetCode}. Known assets: ${Object.keys(KNOWN_ASSETS[network] ?? {}).join(", ")}`,
      );
    }

    return wallet.getBalance(knownAsset);
  }

  async sendPayment(
    id: string,
    destination: string,
    assetCode: string,
    amount: string,
  ): Promise<{ hash: string }> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    let asset: Asset;
    if (assetCode === "XLM") {
      asset = Asset.native();
    } else {
      const network = this.client.config.network;
      const knownAsset = KNOWN_ASSETS[network]?.[assetCode];
      if (!knownAsset) {
        throw new Error(
          `Unknown asset: ${assetCode}. Known assets: ${Object.keys(KNOWN_ASSETS[network] ?? {}).join(", ")}`,
        );
      }
      asset = knownAsset;
    }

    return wallet.send(destination, asset, amount);
  }

  async simulateContract(
    id: string,
    contractId: string,
    method: string,
    args?: ScValInput[],
  ): Promise<ContractSimulationResult> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);
    return wallet.simulateContract(contractId, method, args);
  }

  async invokeContract(
    id: string,
    contractId: string,
    method: string,
    args?: ScValInput[],
    fee?: string,
  ): Promise<{ hash: string }> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);
    return wallet.invokeContract(contractId, method, args, fee);
  }

  /**
   * Establish or modify a trustline for the given wallet.
   *
   * The asset is resolved in this order:
   *   1. If `assetCode` contains a colon (e.g. `"USDC:G..."`), it is parsed
   *      as `<code>:<issuer>` directly.
   *   2. Otherwise, `KNOWN_ASSETS[network][assetCode]` is looked up.
   *
   * Pass `limit = '0'` to remove the trustline.
   *
   * @param id        - wallet id (account address)
   * @param assetCode - the asset code (e.g. `'USDC'`) or a `'CODE:ISSUER'` string
   * @param limit     - maximum balance limit (omit for default; `'0'` to remove)
   */
  async changeTrust(id: string, assetCode: string, limit?: string): Promise<{ hash: string }> {
    const wallet = this.wallets.get(id);
    if (!wallet) throw new Error(`Wallet not found: ${id}`);

    let asset: Asset;

    if (assetCode.includes(":")) {
      // Custom asset passed as "CODE:ISSUER"
      const [code, issuer] = assetCode.split(":", 2) as [string, string];
      asset = new Asset(code, issuer);
    } else {
      const network = this.client.config.network;
      const knownAsset = KNOWN_ASSETS[network]?.[assetCode];
      if (!knownAsset) {
        throw new Error(
          `Unknown asset: ${assetCode}. Pass as 'CODE:ISSUER' or use one of the known assets: ${Object.keys(KNOWN_ASSETS[network] ?? {}).join(", ")}`,
        );
      }
      asset = knownAsset;
    }

    return wallet.changeTrust(asset, limit);
  }

  /**
   * Generic HTTP GET against the configured serverUrl.
   * Used by hooks that need to query server-side endpoints directly.
   */
  async get<T>(path: string): Promise<T> {
    if (!this.serverUrl) throw new Error("serverUrl is required for HTTP calls");
    const res = await fetch(`${this.serverUrl}${path}`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${body}`);
    }
    return res.json() as Promise<T>;
  }
}

export async function createWalletWithPasskey(
  client: LumenClient,
  opts?: PasskeyRegistrationOpts,
): Promise<PasskeyWalletResult> {
  return client.createWalletWithPasskey(opts);
}

export async function signWithPasskey(
  client: LumenClient,
  opts: { credentialId?: string; transactionXdr: string; username?: string },
): Promise<{ signedXdr: string; publicKey: string }> {
  return client.signWithPasskey(opts);
}
