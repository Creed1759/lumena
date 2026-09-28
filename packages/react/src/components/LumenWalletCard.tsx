import React, { useCallback, useState } from "react";
import { LumenBalance } from "./LumenBalance.js";

/** Truncates a Stellar address to the format GXXX...YYYY (first 4 + last 4 chars). */
function truncateAddress(address: string, prefixLen = 4, suffixLen = 4): string {
  if (address.length <= prefixLen + suffixLen + 3) {
    return address;
  }
  return `${address.slice(0, prefixLen)}…${address.slice(-suffixLen)}`;
}

export interface LumenWalletCardProps {
  /** Full Stellar wallet address (public key). */
  walletId: string;
  /** Asset code to display in the balance (e.g. "USDC"). Defaults to native XLM. */
  assetCode?: string;
  /** Auto-refresh interval in milliseconds. Set to 0 to disable. Defaults to 10 000. */
  refreshInterval?: number;
  /** Additional CSS class name(s) for the root card element. */
  className?: string;
  /**
   * Render the QR code for the wallet address.
   * Receives the full wallet address string.
   * If omitted, no QR code is rendered.
   */
  renderQrCode?: (address: string) => React.ReactNode;
  /** Number of characters to show at the start of the truncated address. Defaults to 4. */
  addressPrefixLen?: number;
  /** Number of characters to show at the end of the truncated address. Defaults to 4. */
  addressSuffixLen?: number;
}

/**
 * A pre-built wallet card component that renders the truncated wallet address,
 * a one-click copy button, the balance display, and an optional QR code.
 *
 * Supports custom `className` for styling and `renderQrCode` for full QR
 * code customisation.
 */
export function LumenWalletCard({
  walletId,
  assetCode,
  refreshInterval,
  className,
  renderQrCode,
  addressPrefixLen = 4,
  addressSuffixLen = 4,
}: LumenWalletCardProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(walletId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available in this context — silently ignore.
    }
  }, [walletId]);

  const truncated = truncateAddress(walletId, addressPrefixLen, addressSuffixLen);

  return (
    <div
      className={["lumen-wallet-card", className].filter(Boolean).join(" ")}
      aria-label={`Wallet card for ${truncated}`}
    >
      {/* Address row */}
      <div className="lumen-wallet-card__address-row">
        <span
          className="lumen-wallet-card__address"
          title={walletId}
          aria-label={`Wallet address: ${walletId}`}
        >
          {truncated}
        </span>
        <button
          type="button"
          className="lumen-wallet-card__copy-btn"
          aria-label={copied ? "Address copied" : "Copy wallet address"}
          onClick={() => {
            void handleCopy();
          }}
        >
          {copied ? "✓" : "⧉"}
        </button>
      </div>

      {/* Balance */}
      <div className="lumen-wallet-card__balance-row">
        <LumenBalance
          walletId={walletId}
          assetCode={assetCode}
          refreshInterval={refreshInterval}
          className="lumen-wallet-card__balance"
        />
      </div>

      {/* Optional QR code */}
      {renderQrCode && (
        <div className="lumen-wallet-card__qr-code" aria-label="Wallet QR code">
          {renderQrCode(walletId)}
        </div>
      )}
    </div>
  );
}
