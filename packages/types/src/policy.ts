export interface Policy {
  id: string;
  walletId: string;
  rules: PolicyRule[];
  createdAt: Date;
}

export type PolicyRule =
  | SpendLimit
  | VelocityRule
  | AllowlistRule
  | BlocklistRule
  | SessionKeyPolicyRule
  | TimeBoundsRule
  | MaxOperationsRule
  | FeeLimitRule;
  | ContractAllowlistRule;

export interface SpendLimit {
  type: "spend_limit";
  asset: string;
  maxPerTx: string;
  maxDaily: string;
}

export interface VelocityRule {
  type: "velocity";
  maxTransactions: number;
  windowMinutes: number;
}

export interface AllowlistRule {
  type: "allowlist";
  destinations: string[];
}

export interface BlocklistRule {
  type: "blocklist";
  destinations: string[];
}

export interface SessionKeyPolicyRule {
  type: "session_key";
  sessionPublicKey: string;
  maxSpend: string;
  expiresAt: number;
}

export interface TimeBoundsRule {
  type: "timebounds";
  maxWindowSeconds?: number;
  allowUnbounded?: boolean;
}

export interface MaxOperationsRule {
  type: "max_operations";
  maxOperations: number;
}

export interface FeeLimitRule {
  type: "fee_limit";
  maxFeeStroops: number;
export interface ContractAllowlistRule {
  type: "contract_allowlist";
  allowedContracts: Array<{
    contractId: string;
    /** If omitted or empty, all methods are allowed for this contract. */
    methods?: string[];
  }>;
}

export interface PolicyStore {
  getPolicy(walletId: string): Promise<Policy | null>;
  savePolicy(policy: Policy): Promise<void>;
  deletePolicy(walletId: string): Promise<void>;
  listPolicies(): Promise<Policy[]>;
  recordSpend(
    walletId: string,
    date: string,
    amount: number,
    asset?: string,
  ): Promise<{ dailyTotal: number; txCount: number }>;
  recordVelocity(walletId: string, timestamp: number, windowMs: number): Promise<number>;
}
