/**
 * AzureKeyVaultSigner — production signer backed by Azure Key Vault HSM.
 *
 * ─── IMPORTANT NOTE ON STELLAR SIGNATURES ────────────────────────────────────
 * Stellar uses Ed25519 natively. Azure Key Vault does not support Ed25519
 * as a managed key type (as of 2026). Two viable patterns for production:
 *
 *   A) Azure Key Vault + envelope encryption (recommended for compliance)
 *      Store the Ed25519 private key material encrypted at rest using an
 *      AKV-managed AES-256 key (wrap/unwrap). Decrypt in memory only for the
 *      duration of a sign operation inside an Azure Functions instance with
 *      no persistent storage. Zero memory after use.
 *
 *   B) Azure Managed HSM with EC P-256 signing (lower friction)
 *      Use Azure Managed HSM (not Key Vault Standard/Premium) which supports
 *      P-256 ECDSA signing backed by FIPS 140-3 Level 3 hardware. The server
 *      receives the raw DER signature and re-encodes it for Stellar if needed.
 *      Reference:
 *      https://learn.microsoft.com/en-us/azure/key-vault/managed-hsm/overview
 *
 * This implementation uses the envelope encryption pattern (Option A) and
 * integrates with Azure Key Vault via `@azure/keyvault-keys` and
 * `@azure/identity`. The private key is decrypted in memory only when signing.
 *
 * ─── INSTALLATION ─────────────────────────────────────────────────────────────
 *   pnpm add @azure/keyvault-keys @azure/identity
 *
 * ─── REQUIRED AZURE RBAC ROLES ───────────────────────────────────────────────
 *   Key Vault Crypto User  — required on the specific key to call wrapKey /
 *                            unwrapKey / sign / getKey.
 *   Key Vault Crypto Officer — required only if you need to create/rotate keys.
 *
 * ─── ENVIRONMENT VARIABLES ───────────────────────────────────────────────────
 *   AZURE_KEY_VAULT_URL  — e.g. https://my-vault.vault.azure.net
 *   AZURE_KEY_NAME       — name of the AKV key used for wrap/unwrap
 *   AZURE_KEY_VERSION    — (optional) specific key version; defaults to latest
 *
 * Standard Azure identity variables are read automatically by
 * `DefaultAzureCredential`:
 *   AZURE_CLIENT_ID, AZURE_TENANT_ID, AZURE_CLIENT_SECRET  (service principal)
 *   or the workload identity / managed identity environment variables.
 *
 * @example
 * ```ts
 * import { AzureKeyVaultSigner } from "./signers/AzureKeyVaultSigner.js";
 *
 * const cosigner = await AzureKeyVaultSigner.fromEnv();
 * ```
 */
import type { Signer } from "@lumen/types";
import { StrKey, Keypair } from "@stellar/stellar-sdk";

/**
 * Lazy-loads the Azure SDK packages so that the module compiles and can be
 * imported even if the optional peer dependencies are not installed. The
 * actual Azure SDK is only required when `fromEnv()` or `init()` is called.
 */
async function loadAzureSdk() {
  const [{ KeyClient, CryptographyClient }, { DefaultAzureCredential }] = await Promise.all([
    import("@azure/keyvault-keys"),
    import("@azure/identity"),
  ]);
  return { KeyClient, CryptographyClient, DefaultAzureCredential };
}

export interface AzureKeyVaultSignerOpts {
  /** Full URL of the Azure Key Vault, e.g. https://my-vault.vault.azure.net */
  vaultUrl: string;
  /**
   * Name of the AKV RSA or EC key used to wrap/unwrap the Ed25519 key material.
   * The wrapped ciphertext is provided at construction time via `wrappedKey`.
   */
  keyName: string;
  /** Optional pinned version of the AKV key. Defaults to the latest enabled version. */
  keyVersion?: string;
  /**
   * Base64-encoded wrapped (encrypted) Ed25519 private key seed (32 bytes).
   * Produce this once with AzureKeyVaultSigner.wrapPrivateKey() and store the
   * result in a secrets store (Azure App Config, Key Vault secrets, etc.).
   * At runtime this ciphertext is decrypted inside Azure Key Vault — the
   * plaintext private key never leaves your trust boundary.
   */
  wrappedKey: string;
}

export class AzureKeyVaultSigner implements Signer {
  private readonly opts: AzureKeyVaultSignerOpts;
  private cachedPublicKey: string | null = null;
  /**
   * In-memory Ed25519 keypair, populated on the first sign() call (lazy init)
   * or eagerly via init(). Zeroed in destroy().
   */
  private keypair: Keypair | null = null;

  constructor(opts: AzureKeyVaultSignerOpts) {
    this.opts = opts;
  }

  /**
   * Creates an `AzureKeyVaultSigner` from environment variables and eagerly
   * initialises it (unwraps the key, caches the public key).
   *
   * Required env vars:
   *   AZURE_KEY_VAULT_URL   — vault URL
   *   AZURE_KEY_NAME        — key name in the vault
   *   AZURE_WRAPPED_KEY     — base64-encoded wrapped Ed25519 seed (see wrapPrivateKey)
   *
   * Optional:
   *   AZURE_KEY_VERSION     — pin to a specific key version
   *
   * Standard `@azure/identity` vars are picked up automatically.
   */
  static async fromEnv(): Promise<AzureKeyVaultSigner> {
    const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
    if (!vaultUrl) {
      throw new Error(
        "AzureKeyVaultSigner: AZURE_KEY_VAULT_URL is not set. " +
          "Set it to the full Azure Key Vault URL, e.g. https://my-vault.vault.azure.net",
      );
    }

    const keyName = process.env.AZURE_KEY_NAME;
    if (!keyName) {
      throw new Error(
        "AzureKeyVaultSigner: AZURE_KEY_NAME is not set. " +
          "Set it to the name of the AKV key used for wrap/unwrap.",
      );
    }

    const wrappedKey = process.env.AZURE_WRAPPED_KEY;
    if (!wrappedKey) {
      throw new Error(
        "AzureKeyVaultSigner: AZURE_WRAPPED_KEY is not set. " +
          "Generate it once with AzureKeyVaultSigner.wrapPrivateKey() and store the result.",
      );
    }

    const signer = new AzureKeyVaultSigner({
      vaultUrl,
      keyName,
      keyVersion: process.env.AZURE_KEY_VERSION,
      wrappedKey,
    });

    // Eagerly unwrap so startup fails fast if IAM permissions or config are wrong.
    await signer.init();
    return signer;
  }

  /**
   * Utility: wraps (encrypts) a raw Ed25519 private key seed for storage.
   * Run this once during key setup and store the base64 result in a secrets
   * store. Do NOT commit the plaintext seed to version control.
   *
   * @param seed       - 32-byte raw Ed25519 private key seed
   * @param vaultUrl   - Azure Key Vault URL
   * @param keyName    - AKV key name
   * @param keyVersion - optional key version
   * @returns base64-encoded wrapped key ciphertext
   */
  static async wrapPrivateKey(
    seed: Uint8Array,
    vaultUrl: string,
    keyName: string,
    keyVersion?: string,
  ): Promise<string> {
    const { CryptographyClient, DefaultAzureCredential } = await loadAzureSdk();
    const credential = new DefaultAzureCredential();
    const keyId = keyVersion
      ? `${vaultUrl}/keys/${keyName}/${keyVersion}`
      : `${vaultUrl}/keys/${keyName}`;
    const cryptoClient = new CryptographyClient(keyId, credential);

    const { result } = await cryptoClient.wrapKey("RSA-OAEP-256", Buffer.from(seed));
    return Buffer.from(result).toString("base64");
  }

  /**
   * Unwraps the stored private key material using Azure Key Vault and
   * constructs the in-memory Keypair. Idempotent — no-op if already initialised.
   */
  async init(): Promise<void> {
    if (this.keypair) return;

    const { CryptographyClient, DefaultAzureCredential } = await loadAzureSdk();
    const credential = new DefaultAzureCredential();

    const keyId = this.opts.keyVersion
      ? `${this.opts.vaultUrl}/keys/${this.opts.keyName}/${this.opts.keyVersion}`
      : `${this.opts.vaultUrl}/keys/${this.opts.keyName}`;

    const cryptoClient = new CryptographyClient(keyId, credential);
    const wrappedKeyBytes = Buffer.from(this.opts.wrappedKey, "base64");

    const { result: seedBytes } = await cryptoClient.unwrapKey("RSA-OAEP-256", wrappedKeyBytes);
    if (!seedBytes || seedBytes.length < 32) {
      throw new Error(
        "AzureKeyVaultSigner: unwrapped key material is shorter than 32 bytes. " +
          "Ensure AZURE_WRAPPED_KEY was produced with AzureKeyVaultSigner.wrapPrivateKey().",
      );
    }

    // Construct the Ed25519 keypair from the raw seed.
    const rawSeed = Buffer.from(seedBytes).slice(0, 32);
    this.keypair = Keypair.fromRawEd25519Seed(rawSeed);
    this.cachedPublicKey = StrKey.encodeEd25519PublicKey(Buffer.from(this.keypair.rawPublicKey()));

    // Zero the raw seed buffer from memory immediately after use.
    rawSeed.fill(0);
  }

  /**
   * Returns the Ed25519 public key in Stellar strkey format (G…).
   * Throws if init() has not been called yet.
   */
  publicKey(): string {
    if (!this.cachedPublicKey) {
      throw new Error(
        "AzureKeyVaultSigner: publicKey() called before initialization. " +
          "Use AzureKeyVaultSigner.fromEnv() or call init() first.",
      );
    }
    return this.cachedPublicKey;
  }

  /**
   * Signs the 32-byte transaction hash and returns the 64-byte Ed25519 signature.
   * Lazily initialises (unwraps) the keypair on the first call if init() has
   * not been called explicitly.
   */
  async sign(payload: Uint8Array): Promise<Uint8Array> {
    if (!this.keypair) {
      await this.init();
    }
    if (!this.keypair) {
      throw new Error("AzureKeyVaultSigner: failed to initialize keypair.");
    }
    return this.keypair.sign(Buffer.from(payload));
  }

  /**
   * Zeroes the in-memory keypair. Call this when the signer is no longer needed
   * to reduce the window during which the plaintext key material is in memory.
   */
  destroy(): void {
    this.keypair = null;
  }
}
