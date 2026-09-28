import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

export const CosignRequestSchema = z.object({
  xdr: z.string().min(1, "xdr is required"),
  walletAddress: z.string().refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message: "walletAddress must be a valid Stellar public key",
  }),
});

export const FeeBumpRequestSchema = z.object({
  xdr: z.string().min(1, "xdr is required"),
});

const SpendLimitSchema = z.object({
  type: z.literal("spend_limit"),
  asset: z.string().min(1, "asset is required"),
  maxPerTx: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/, "maxPerTx must be a decimal string"),
  maxDaily: z.string().regex(/^[0-9]+(?:\.[0-9]+)?$/, "maxDaily must be a decimal string"),
});

const VelocityRuleSchema = z.object({
  type: z.literal("velocity"),
  maxTransactions: z.number().int().positive("maxTransactions must be a positive integer"),
  windowMinutes: z.number().int().positive("windowMinutes must be a positive integer"),
});

const AllowlistRuleSchema = z.object({
  type: z.literal("allowlist"),
  destinations: z
    .array(z.string().startsWith("G", "destination must be a valid Stellar public key"))
    .min(1, "At least one destination is required"),
});

const BlocklistRuleSchema = z.object({
  type: z.literal("blocklist"),
  destinations: z
    .array(z.string().startsWith("G", "destination must be a valid Stellar public key"))
    .min(1, "At least one destination is required"),
});

const MaxOperationsRuleSchema = z.object({
  type: z.literal("max_operations"),
  maxOperations: z.number().int().positive("maxOperations must be a positive integer"),
});

const FeeLimitRuleSchema = z.object({
  type: z.literal("fee_limit"),
  maxFeeStroops: z.number().int().positive("maxFeeStroops must be a positive integer"),
const ContractAllowlistRuleSchema = z.object({
  type: z.literal("contract_allowlist"),
  allowedContracts: z
    .array(
      z.object({
        contractId: z.string().min(1, "contractId is required"),
        methods: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1, "At least one contract must be specified"),
});

const PolicyRuleSchema = z.discriminatedUnion("type", [
  SpendLimitSchema,
  VelocityRuleSchema,
  AllowlistRuleSchema,
  BlocklistRuleSchema,
  MaxOperationsRuleSchema,
  FeeLimitRuleSchema,
  ContractAllowlistRuleSchema,
]);

export const PolicyRequestSchema = z.object({
  walletId: z.string().regex(/^G[A-Z2-7]{55}$/, "walletId must be a valid Stellar public key"),
  rules: z.array(PolicyRuleSchema).min(1, "At least one rule is required"),
});

export type CosignRequest = z.infer<typeof CosignRequestSchema>;
export type FeeBumpRequest = z.infer<typeof FeeBumpRequestSchema>;
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export const WebhookRequestSchema = z.object({
  id: z.string().optional(),
  url: z.string().url("url must be a valid URL"),
  secret: z.string().min(1, "secret is required"),
  events: z.array(z.string().min(1)).min(1, "at least one event is required"),
  enabled: z.boolean().optional(),
});

export type WebhookRequest = z.infer<typeof WebhookRequestSchema>;

/**
 * Schema for PATCH /webhooks/:id — all fields are optional.
 * At least one field must be present.
 */
export const WebhookPatchSchema = z
  .object({
    url: z.string().url("url must be a valid URL").optional(),
    events: z.array(z.string().min(1)).min(1, "at least one event is required").optional(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field (url, events, or enabled) must be provided",
  });

export type WebhookPatch = z.infer<typeof WebhookPatchSchema>;
