import fs from "node:fs";
import path from "node:path";
import type { Policy, PolicyStore } from "@lumen/types";

export class InMemoryPolicyStore implements PolicyStore {
  private policies: Map<string, Policy> = new Map();
  private spendTracking: Map<string, Map<string, { dailyTotal: number; txCount: number }>> =
    new Map();
  private velocityTracking: Map<string, number[]> = new Map();

  async getPolicy(walletId: string): Promise<Policy | null> {
    return this.policies.get(walletId) ?? null;
  }

  async listPolicies(): Promise<Policy[]> {
    return Array.from(this.policies.values());
  }

  async savePolicy(policy: Policy): Promise<void> {
    this.policies.set(policy.walletId, policy);
  }

  async deletePolicy(walletId: string): Promise<void> {
    this.policies.delete(walletId);
    this.spendTracking.delete(walletId);
    this.velocityTracking.delete(walletId);
  }

  async recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset: string = "native",
  ): Promise<{ dailyTotal: number; txCount: number }> {
    if (!this.spendTracking.has(walletId)) {
      this.spendTracking.set(walletId, new Map());
    }
    const walletTrack = this.spendTracking.get(walletId)!;
    const trackKey = `${date}:${asset}`;

    if (!walletTrack.has(trackKey)) {
      walletTrack.set(trackKey, { dailyTotal: 0, txCount: 0 });
    }
    const track = walletTrack.get(trackKey)!;
    track.dailyTotal += amount;
    track.txCount += 1;

    return { dailyTotal: track.dailyTotal, txCount: track.txCount };
  }

  async recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number> {
    if (!this.velocityTracking.has(walletId)) {
      this.velocityTracking.set(walletId, []);
    }
    const txTimes = this.velocityTracking.get(walletId)!;
    const cutoff = timestamp - windowMs;
    const recentTxs = txTimes.filter((t) => t > cutoff);
    recentTxs.push(timestamp);
    this.velocityTracking.set(walletId, recentTxs);

    return recentTxs.length;
  }
}

export class FilePolicyStore implements PolicyStore {
  private readonly filePath: string;
  private policies: Map<string, Policy> = new Map();
  private spendTracking: Map<string, Map<string, { dailyTotal: number; txCount: number }>> =
    new Map();
  private velocityTracking: Map<string, number[]> = new Map();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromFile();
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && item.walletId) {
                if (item.createdAt && typeof item.createdAt === "string") {
                  item.createdAt = new Date(item.createdAt);
                }
                this.policies.set(item.walletId, item);
              }
            }
          } else if (typeof parsed === "object" && parsed !== null) {
            for (const item of Object.values(parsed)) {
              const p = item as Policy;
              if (p && p.walletId) {
                if (p.createdAt && typeof p.createdAt === "string") {
                  p.createdAt = new Date(p.createdAt);
                }
                this.policies.set(p.walletId, p);
              }
            }
          }
        }
      }
    } catch {
      // In case of read/parse failure, initialize with empty state
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.promises.mkdir(dir, { recursive: true });

    const tempPath = `${this.filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    const data = JSON.stringify(Array.from(this.policies.values()), null, 2);

    await fs.promises.writeFile(tempPath, data, "utf-8");
    await fs.promises.rename(tempPath, this.filePath);
  }

  async getPolicy(walletId: string): Promise<Policy | null> {
    return this.policies.get(walletId) ?? null;
  }

  async listPolicies(): Promise<Policy[]> {
    return Array.from(this.policies.values());
  }

  async savePolicy(policy: Policy): Promise<void> {
    this.policies.set(policy.walletId, policy);
    await this.persist();
  }

  async deletePolicy(walletId: string): Promise<void> {
    this.policies.delete(walletId);
    this.spendTracking.delete(walletId);
    this.velocityTracking.delete(walletId);
    await this.persist();
  }

  async recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset: string = "native",
  ): Promise<{ dailyTotal: number; txCount: number }> {
    if (!this.spendTracking.has(walletId)) {
      this.spendTracking.set(walletId, new Map());
    }
    const walletTrack = this.spendTracking.get(walletId)!;
    const trackKey = `${date}:${asset}`;

    if (!walletTrack.has(trackKey)) {
      walletTrack.set(trackKey, { dailyTotal: 0, txCount: 0 });
    }
    const track = walletTrack.get(trackKey)!;
    track.dailyTotal += amount;
    track.txCount += 1;

    return { dailyTotal: track.dailyTotal, txCount: track.txCount };
  }

  async recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number> {
    if (!this.velocityTracking.has(walletId)) {
      this.velocityTracking.set(walletId, []);
    }
    const txTimes = this.velocityTracking.get(walletId)!;
    const cutoff = timestamp - windowMs;
    const recentTxs = txTimes.filter((t) => t > cutoff);
    recentTxs.push(timestamp);
    this.velocityTracking.set(walletId, recentTxs);

    return recentTxs.length;
  }
}

export interface RedisClientInterface {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incrbyfloat(key: string, increment: number | string): Promise<string>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  zcard(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export class RedisPolicyStore implements PolicyStore {
  private redis: RedisClientInterface;
  private keyPrefix: string;

  constructor(redisClient: RedisClientInterface, keyPrefix: string = "lumen:") {
    this.redis = redisClient;
    this.keyPrefix = keyPrefix;
  }

  async getPolicy(walletId: string): Promise<Policy | null> {
    const raw = await this.redis.get(`${this.keyPrefix}policy:${walletId}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.createdAt) {
        parsed.createdAt = new Date(parsed.createdAt);
      }
      return parsed as Policy;
    } catch {
      return null;
    }
  }

  async listPolicies(): Promise<Policy[]> {
    const keys = await this.redis.keys(`${this.keyPrefix}policy:*`);
    const policies: Policy[] = [];
    for (const key of keys) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed.createdAt) {
          parsed.createdAt = new Date(parsed.createdAt);
        }
        policies.push(parsed as Policy);
      } catch {
        // skip unparseable entries
      }
    }
    return policies;
  }

  async savePolicy(policy: Policy): Promise<void> {
    const key = `${this.keyPrefix}policy:${policy.walletId}`;
    await this.redis.set(key, JSON.stringify(policy));
  }

  async deletePolicy(walletId: string): Promise<void> {
    const key = `${this.keyPrefix}policy:${walletId}`;
    await this.redis.del(key);
  }

  async recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset: string = "native",
  ): Promise<{ dailyTotal: number; txCount: number }> {
    const totalKey = `${this.keyPrefix}spend:${walletId}:${asset}:${date}:total`;
    const countKey = `${this.keyPrefix}spend:${walletId}:${asset}:${date}:count`;

    const newTotalStr = await this.redis.incrbyfloat(totalKey, amount);
    const newCount = await this.redis.incr(countKey);

    // Set 48 hour TTL for daily spend keys
    const ttlSeconds = 172800;
    await this.redis.expire(totalKey, ttlSeconds);
    await this.redis.expire(countKey, ttlSeconds);

    return {
      dailyTotal: parseFloat(newTotalStr || "0"),
      txCount: newCount,
    };
  }

  async recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number> {
    const key = `${this.keyPrefix}velocity:${walletId}`;
    const cutoff = timestamp - windowMs;
    const member = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;

    await this.redis.zadd(key, timestamp, member);
    await this.redis.zremrangebyscore(key, "-inf", cutoff);

    const count = await this.redis.zcard(key);

    const ttlSeconds = Math.max(Math.ceil(windowMs / 1000) * 2, 3600);
    await this.redis.expire(key, ttlSeconds);

    return count;
  }
}
