/**
 * WalletRegistry — persist and enumerate registered wallet addresses.
 *
 * The interface is intentionally minimal so it can be backed by in-memory
 * storage, Redis, a database, or any other persistence layer.
 */
export interface WalletRegistry {
  /** Persist a wallet address. Implementations should deduplicate. */
  register(address: string): Promise<void> | void;
  /** Return all registered wallet addresses. */
  list(): Promise<string[]> | string[];
}

export interface WalletRegistryEntry {
  address: string;
  registeredAt: Date;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryWalletRegistry implements WalletRegistry {
  private addresses: string[] = [];

  register(address: string): void {
    if (!this.addresses.includes(address)) {
      this.addresses.push(address);
    }
  }

  list(): string[] {
    return [...this.addresses];
  }
}

// ---------------------------------------------------------------------------
// Redis implementation
// ---------------------------------------------------------------------------

export interface RedisWalletRegistryOpts {
  /** Redis client — must support SADD, SMEMBERS. */
  redis: {
    sadd(key: string, ...members: string[]): Promise<number>;
    smembers(key: string): Promise<string[]>;
  };
  /** Key used to store the wallet set. Defaults to "lumen:wallets". */
  key?: string;
}

export class RedisWalletRegistry implements WalletRegistry {
  private readonly redis: RedisWalletRegistryOpts["redis"];
  private readonly key: string;

  constructor(opts: RedisWalletRegistryOpts) {
    this.redis = opts.redis;
    this.key = opts.key ?? "lumen:wallets";
  }

  async register(address: string): Promise<void> {
    await this.redis.sadd(this.key, address);
  }

  async list(): Promise<string[]> {
    return this.redis.smembers(this.key);
  }
}
