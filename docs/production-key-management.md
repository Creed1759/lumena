# Production Key Management

This document covers everything you need to know before running Lumen in
production with real user funds.

---

## Table of contents

1. [Threat model](#1-threat-model)
2. [Default (dev) configuration and why it is not safe for production](#2-default-dev-configuration)
3. [The Signer abstraction](#3-the-signer-abstraction)
4. [AWS KMS / CloudHSM setup](#4-aws-kms--cloudhsm-setup)
5. [Other HSM options](#5-other-hsm-options)
6. [Key rotation policy](#6-key-rotation-policy)
7. [Blast-radius capping for the fee-sponsor account](#7-blast-radius-capping-for-the-fee-sponsor-account)
8. [Least-privilege IAM policy (AWS)](#8-least-privilege-iam-policy-aws)
9. [Audit logging](#9-audit-logging)
10. [Incident response checklist](#10-incident-response-checklist)
11. [Production checklist](#11-production-checklist)

---

## 1. Threat model

The Lumen server holds two custodial keys:

| Key | What it can do if stolen |
|---|---|
| **Co-signer** (`COSIGNER_SECRET` / `KMS_COSIGNER_KEY_ID`) | Co-sign arbitrary user transactions that pass policy checks.  An attacker could drain every wallet Lumen manages without the user's device key—if they also steal the user device key—or, with a malicious policy override, bypass spend limits entirely. |
| **Fee-payer** (`FEE_PAYER_SECRET` / `KMS_FEE_PAYER_KEY_ID`) | Submit fee-bumped transactions, spending XLM from the fee-payer account.  An attacker can drain the entire XLM balance held there. |

Both keys are therefore **high-value custodial secrets**.  They must never
appear in application logs, crash dumps, environment variables in plain text
in production, or version control.

## Browser wallet key storage

`@lumen/core`'s `KeyManager` stores encrypted key records in browser
`localStorage` by default, so they remain available after a refresh or tab
closure. The records contain AES-GCM ciphertext, not plaintext secret keys;
the passphrase is required to load a key. Applications can inject a
`KeyStorage` implementation when they need a different persistent backend.
Non-browser runtimes without `localStorage` use in-memory storage by default.
Because browser storage is accessible to same-origin scripts, protect the
application against cross-site scripting and do not treat `localStorage` as a
trusted secret store.

---

## 2. Default (dev) configuration

Out of the box, with `SIGNER_PROVIDER=env`, both keys are read from environment
variables as raw Stellar secret key strings (`S…`):

```
COSIGNER_SECRET=SXXXXX...
FEE_PAYER_SECRET=SXXXXX...
```

This is **acceptable only for local development and testnet**, where the keys
hold no real value.  In any environment where:

- users hold real XLM or tokens,
- the server is reachable from the internet, or
- the service runs on shared infrastructure (PaaS, container orchestrator, etc.),

you must use a hardware-backed signing provider.

---

## 3. The Signer abstraction

`@lumen/types` exposes a `Signer` interface:

```ts
export interface Signer {
  publicKey(): string;
  sign(payload: Buffer): Promise<Buffer>;
}
```

`CosignerService` and `FeeSponsorService` depend only on this interface.
Switching from env-based keys to KMS is purely a wiring change in `main.ts` —
the service logic is unchanged.

Two implementations ship with the server:

| Class | Location | Use case |
|---|---|---|
| `EnvSigner` | `src/signers/EnvSigner.ts` | Dev / testnet only |
| `AwsKmsSigner` | `src/signers/AwsKmsSigner.ts` | AWS KMS production signer |
| `GcpKmsSigner` | `src/signers/GcpKmsSigner.ts` | Google Cloud KMS asymmetric signer |
| `VaultSigner` | `src/signers/VaultSigner.ts` | HashiCorp Vault Transit native Ed25519 signer |
| `AzureKeyVaultSigner` | `src/signers/AzureKeyVaultSigner.ts` | Azure Key Vault envelope-encryption signer |

To add your own provider (HashiCorp Vault, GCP KMS, Nitro Enclave, etc.),
implement the `Signer` interface and wire it in `main.ts`.

---

## 4. AWS KMS / CloudHSM setup

### 4.1 Key type note

Stellar uses **Ed25519** natively.  As of mid-2026, AWS KMS does not expose
Ed25519 as a standalone managed key type.  Two viable approaches:

**Option A — AWS KMS with CloudHSM custom key store (recommended)**

Store the Ed25519 key material inside an AWS CloudHSM cluster and import it
into KMS as an EXTERNAL key.  The private key never leaves the HSM boundary;
KMS exposes a `Sign` API that your server calls.

Reference:
https://docs.aws.amazon.com/kms/latest/developerguide/custom-key-store-overview.html

**Option B — KMS data-key envelope encryption (lower cost, higher ops burden)**

Use KMS `GenerateDataKey` to obtain an AES-256 data key.  Encrypt the Ed25519
private key with the data key and store the ciphertext in a secrets store
(Secrets Manager, Parameter Store).  At startup, call KMS `Decrypt` to get the
plaintext data key, decrypt the Ed25519 key in memory, and zero it from memory
after signing.

This keeps the key out of version control and environment variables, but it
*does* briefly exist in process memory.  Combine with:
- Lambda (stateless, short-lived) or Fargate with no persistent storage
- Memory-locked pages (`mlock`) if available
- AWS Nitro Enclaves for cryptographic process isolation

### 4.2 Creating the KMS keys

```bash
# Co-signer key
aws kms create-key \
  --description "Lumen co-signer key" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_P256 \   # replace with Ed25519 once supported
  --origin AWS_KMS \
  --region us-east-1

# Fee-payer key
aws kms create-key \
  --description "Lumen fee-payer key" \
  --key-usage SIGN_VERIFY \
  --key-spec ECC_NIST_P256 \
  --origin AWS_KMS \
  --region us-east-1
```

Note the ARNs.  Add aliases for readability:

```bash
aws kms create-alias \
  --alias-name alias/lumen-cosigner \
  --target-key-id <arn>

aws kms create-alias \
  --alias-name alias/lumen-fee-payer \
  --target-key-id <arn>
```

### 4.3 Environment variables

```bash
SIGNER_PROVIDER=awskms
KMS_COSIGNER_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/<uuid>
KMS_FEE_PAYER_KEY_ID=arn:aws:kms:us-east-1:123456789012:key/<uuid>
KMS_REGION=us-east-1
```

Leave `COSIGNER_SECRET` and `FEE_PAYER_SECRET` **unset**.

### 4.4 Completing the AwsKmsSigner stub

`src/signers/AwsKmsSigner.ts` ships as a stub with detailed inline guidance.
The two methods that need to be filled in are:

- `publicKey()` — call `GetPublicKey`, parse the DER-encoded SubjectPublicKeyInfo,
  extract the 32-byte raw public key, and encode it as a Stellar strkey.
- `sign(payload)` — call `Sign` with `MessageType: "RAW"`, decode the DER
  signature to 64-byte `(r || s)` form.

```bash
pnpm add @aws-sdk/client-kms
pnpm add @noble/curves   # for DER parsing helpers
```

---

## 5. Other HSM options

### HashiCorp Vault Transit
 
 Vault Transit supports **Ed25519 natively**, which removes the key-type
 mismatch.  It works on-premises, in HashiCorp Cloud Platform (HCP), and in self-hosted environments.
 
 ```bash
 # Enable Transit engine
 vault secrets enable transit
 
 # Create co-signer key with ed25519 type
 vault write transit/keys/lumen-cosigner type=ed25519
 
 # Create fee-payer key with ed25519 type
 vault write transit/keys/lumen-fee-payer type=ed25519
 ```
 
 #### Environment Variables for VaultSigner
 ```bash
 SIGNER_PROVIDER=vault
 VAULT_ADDR=https://vault.yourdomain.com:8200
 VAULT_TOKEN=s.exampletoken
 VAULT_KEY_NAME=lumen-cosigner
 VAULT_MOUNT_PATH=transit
 VAULT_NAMESPACE=finance/lumen # optional
 ```
 
 Usage with `VaultSigner`:
 ```ts
 import { VaultSigner } from "@lumen/server";
 
 const signer = await VaultSigner.fromEnv("VAULT");
 ```
 
 ### GCP Cloud KMS
 
 GCP Cloud KMS supports asymmetric signing with keys stored in Cloud HSM.
 
 #### Creating Keys in GCP Cloud KMS
 ```bash
 # Create key ring
 gcloud kms keyrings create lumen-ring \
   --location global
 
 # Create asymmetric signing key
 gcloud kms keys create lumen-cosigner \
   --location global \
   --keyring lumen-ring \
   --purpose asymmetric-signing \
   --default-algorithm ec-sign-ed25519-sha512
 ```
 
 #### Environment Variables for GcpKmsSigner
 ```bash
 SIGNER_PROVIDER=gcpkms
 GCP_KMS_KEY_RESOURCE_NAME=projects/MY_PROJECT/locations/global/keyRings/lumen-ring/cryptoKeys/lumen-cosigner/cryptoKeyVersions/1
 GCP_KMS_ACCESS_TOKEN=ya29... # optional if using Google Default Application Credentials
 ```
 
 Usage with `GcpKmsSigner`:
 ```ts
 import { GcpKmsSigner } from "@lumen/server";
 
 const signer = await GcpKmsSigner.fromEnv("GCP_KMS");
 ```

### Azure Key Vault

Azure Key Vault does not support Ed25519 natively (as of 2026). `AzureKeyVaultSigner`
uses the **envelope encryption** pattern: the Ed25519 private key seed is wrapped
(AES-256 encrypted) by an AKV RSA key and stored outside the vault; it is only
decrypted in memory for the duration of each sign operation.

#### Installation

```bash
pnpm add @azure/keyvault-keys @azure/identity
```

#### Required RBAC Roles

Assign these roles to the managed identity or service principal running Lumen:

| Role | Scope | Purpose |
|---|---|---|
| `Key Vault Crypto User` | Key resource | `wrapKey`, `unwrapKey`, `getKey` |
| `Key Vault Crypto Officer` | Key resource | Only needed for key creation/rotation |

> **Important:** Do **not** grant `Key Vault Administrator` or any data plane
> wildcard role. Least-privilege means Crypto User only.

#### Creating the Wrapping Key in Azure Key Vault

```bash
# Create a key vault (skip if one already exists)
az keyvault create \
  --name my-lumen-vault \
  --resource-group my-rg \
  --location eastus \
  --sku premium   # premium supports HSM-backed keys

# Create an RSA-HSM wrapping key for the co-signer
az keyvault key create \
  --vault-name my-lumen-vault \
  --name lumen-cosigner-wrap \
  --kty RSA-HSM \
  --size 4096

# Create an RSA-HSM wrapping key for the fee-payer
az keyvault key create \
  --vault-name my-lumen-vault \
  --name lumen-feepayer-wrap \
  --kty RSA-HSM \
  --size 4096
```

#### Wrapping the Ed25519 Private Key Seed (one-time setup)

Run this once in a trusted environment (not the production server) to produce
the wrapped key ciphertext you will store in your secrets manager:

```ts
import { AzureKeyVaultSigner } from "@lumen/server";
import { Keypair } from "@stellar/stellar-sdk";

// Generate a new Ed25519 keypair (or use an existing one)
const keypair = Keypair.random();
const rawSeed = keypair.rawSecretKey(); // 32 bytes

// Wrap the seed using Azure Key Vault
const wrappedKey = await AzureKeyVaultSigner.wrapPrivateKey(
  rawSeed,
  "https://my-lumen-vault.vault.azure.net",
  "lumen-cosigner-wrap",
);

console.log("Public key (store in .env):", keypair.publicKey());
console.log("Wrapped key (store in secrets manager):", wrappedKey);

// Zero the plaintext seed immediately
rawSeed.fill(0);
```

Store the base64-encoded `wrappedKey` output in Azure App Configuration, Key
Vault Secrets, or a CI/CD secrets store. **Never** commit it to version control.

#### Environment Variables for AzureKeyVaultSigner

```bash
SIGNER_PROVIDER=azurekeyvault
AZURE_KEY_VAULT_URL=https://my-lumen-vault.vault.azure.net
AZURE_KEY_NAME=lumen-cosigner-wrap
AZURE_WRAPPED_KEY=<base64-wrapped-seed-from-setup-step>

# Standard Azure identity variables (pick one auth method):

# Option A: Service principal
AZURE_CLIENT_ID=<sp-client-id>
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_SECRET=<sp-secret>

# Option B: Managed identity (recommended on Azure-hosted infra)
# No extra variables needed; DefaultAzureCredential picks up the IMDS endpoint.
```

Usage with `AzureKeyVaultSigner`:

```ts
import { AzureKeyVaultSigner } from "@lumen/server";

const cosigner = await AzureKeyVaultSigner.fromEnv();
const feePayer = await AzureKeyVaultSigner.fromEnv(); // uses same env vars; set different ones per instance
```

Wire it into `main.ts` exactly as you would any other `Signer`:

```ts
import { createServer } from "@lumen/server";
import { AzureKeyVaultSigner } from "@lumen/server";

const cosignerSigner = await AzureKeyVaultSigner.fromEnv();
createServer({ cosignerSigner, feePayerSigner: cosignerSigner, ... });
```

#### Security Notes

- The plaintext seed is decrypted only in memory, for the duration of `init()`,
  and is immediately zeroed after the `Keypair` object is constructed.
- Call `signer.destroy()` when the process shuts down to clear the in-memory keypair.
- Use a **Premium** or **Managed HSM** tier Key Vault for hardware-backed key storage.
- Rotate the wrapping key annually or after any suspected compromise (see §6).
- Enable Azure Key Vault [diagnostic logging](https://learn.microsoft.com/en-us/azure/key-vault/general/monitor-key-vault)
  and ship logs to an immutable store (Azure Monitor Log Analytics with archive policy).

---

## 6. Key rotation policy

### Co-signer key

| Event | Action |
|---|---|
| Scheduled rotation | Every 90 days (or per your compliance policy) |
| Suspected compromise | Immediately — see [Incident response](#10-incident-response-checklist) |
| Staff changes | Within 24 hours of any team member leaving who had key access |

**Rotation procedure (KMS):**

1. Generate a new KMS key.
2. Derive its public key and note the Stellar G… address.
3. For each managed wallet, submit a `setOptions` transaction that replaces the
   old server signer public key with the new one (threshold remains 2-of-2).
   This requires the user's device key plus the old co-signer key.
4. Update `KMS_COSIGNER_KEY_ID` in your deployment environment.
5. Deploy the new config and verify the health endpoint.
6. Schedule deletion of the old KMS key (AWS enforces a 7–30 day waiting period
   — keep it enabled until all in-flight transactions clear).

**Rotation procedure (env key):**

Steps 3–6 above, plus generate a new `COSIGNER_SECRET` with:

```bash
node -e "const { Keypair } = require('@stellar/stellar-sdk'); \
  console.log(Keypair.random().secret());"
```

### Fee-payer key

1. Generate a new keypair / KMS key.
2. Transfer the XLM balance from the old account to the new account.
   Leave a small reserve (~1 XLM) on the old account until all pending
   fee-bumps have settled.
3. Update `FEE_PAYER_SECRET` or `KMS_FEE_PAYER_KEY_ID` and deploy.
4. Verify by submitting a test transaction.
5. Merge or retire the old account after the reserve window.

---

## 7. Blast-radius capping for the fee-sponsor account

The fee-payer account holds XLM used to pay fees for every user transaction.
If it is compromised, the attacker can drain it.

### Hard cap: minimum working balance

Keep only enough XLM in the fee-payer account to cover expected transaction
volume over a short window (e.g., 24–48 hours), not the entire float.

A useful formula:

```
working_balance = (expected_tx_per_day × 1.5) × fee_per_tx_in_XLM + reserve
```

Example: 1,000 tx/day × 1.5 buffer × 0.001 XLM/tx + 2 XLM reserve ≈ 3.5 XLM

### Automated top-up

Maintain a "treasury" account with the bulk of your XLM.  Run a scheduled job
that monitors the fee-payer balance and tops it up when it falls below a
threshold.

```ts
// Pseudocode for a top-up Lambda
const balance = await horizon.loadAccount(FEE_PAYER_ADDRESS);
const xlm = parseFloat(balance.balances.find(b => b.asset_type === "native").balance);
if (xlm < TOP_UP_THRESHOLD) {
  await treasury.sendPayment(FEE_PAYER_ADDRESS, TOP_UP_AMOUNT);
}
```

### Alerts

Set CloudWatch (or equivalent) alarms on:

- Fee-payer balance drops below `LOW_BALANCE_ALERT_THRESHOLD`
- Unusual fee-bump submission volume (>N per minute)
- Failed fee-bump submissions spike (could indicate an attack or a bug)

### Additional Stellar-level controls

Stellar account options you can set to limit blast radius:

```
setOptions({
  masterWeight: 0,           // Disable the master key if using a multisig setup
  lowThreshold: 1,
  medThreshold: 2,
  highThreshold: 2,
  homeDomain: "yourservice.com",
})
```

Consider also flagging the fee-payer account as **not sponsoring new entries**
once wallet creation volume is predictable, so an attacker cannot use it to
sponsor malicious accounts.

---

## 8. Least-privilege IAM policy (AWS)

Attach this policy to the ECS task role / Lambda execution role.  It allows
signing only, using only the two named keys, and nothing else.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LumenKmsSign",
      "Effect": "Allow",
      "Action": [
        "kms:Sign",
        "kms:GetPublicKey"
      ],
      "Resource": [
        "arn:aws:kms:<region>:<account>:key/<cosigner-key-uuid>",
        "arn:aws:kms:<region>:<account>:key/<fee-payer-key-uuid>"
      ]
    }
  ]
}
```

Do **not** grant `kms:Decrypt`, `kms:GenerateDataKey`, `kms:CreateKey`, or
any `kms:*` wildcard.  The server only needs to sign.

---

## 9. Audit logging

Every co-sign and fee-bump request should produce a structured audit log entry.
At minimum, log:

```json
{
  "timestamp": "2026-07-14T16:00:00Z",
  "event": "cosign.approved",
  "walletAddress": "G...",
  "transactionHash": "abc123...",
  "signerPublicKey": "G...",
  "policyId": "uuid",
  "sourceIp": "1.2.3.4",
  "requestId": "uuid"
}
```

Rejected requests should log `"event": "cosign.rejected"` with the `reason` field.

Ship these logs to an immutable store (CloudWatch Logs with a retention policy
and no-delete SCPs, S3 Object Lock, etc.) so they can be used for incident
forensics.

KMS itself produces CloudTrail events for every `Sign` call.  Enable CloudTrail
in your account and ensure the trail is protected:

```bash
aws cloudtrail update-trail \
  --name <trail-name> \
  --enable-log-file-validation \
  --kms-key-id arn:aws:kms:...
```

---

## 10. Incident response checklist

If you suspect either key has been compromised:

1. **Rotate immediately.**
   - KMS: Disable the old key (`aws kms disable-key --key-id <arn>`).
   - Env: Remove `COSIGNER_SECRET` / `FEE_PAYER_SECRET` from the deployment
     config and redeploy.

2. **For the co-signer key:**  The attacker still needs the user device keys
   to fully exploit this.  Assess whether any wallets show unexpected
   co-signed transactions in the recent ledger history.  Use Horizon's
   `GET /accounts/{id}/transactions` to audit.

3. **For the fee-payer key:**  Check the fee-payer account for unusual outbound
   payments.  If XLM has been drained, merge remaining balance out and retire
   the account.

4. **Notify affected users** per your disclosure policy.

5. **Review CloudTrail / application logs** for the time window of suspected
   compromise to determine scope.

6. **File an after-action report** and update this runbook.

---

## 11. Production checklist

Before going live with real user funds:

- [ ] `SIGNER_PROVIDER=awskms` (or equivalent HSM provider) is set
- [ ] `COSIGNER_SECRET` and `FEE_PAYER_SECRET` are **not** set in production config
- [ ] KMS keys are in a custom key store backed by CloudHSM (or equivalent)
- [ ] IAM policy is least-privilege (Sign + GetPublicKey only, scoped to key ARNs)
- [ ] CloudTrail is enabled and log file validation is on
- [ ] Structured audit logs are shipped to an immutable store
- [ ] Fee-payer balance cap is configured with automated top-up
- [ ] Low-balance and anomalous-volume alerts are active
- [ ] Key rotation schedule is documented and rehearsed
- [ ] Incident response runbook (§10) has been reviewed by the team
- [ ] `.env` is in `.gitignore` and no secrets are committed to version control
- [ ] `STELLAR_NETWORK=mainnet` (not testnet) is set in the production environment
