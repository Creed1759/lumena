import React, { type ButtonHTMLAttributes } from "react";
import { useBalance } from "../use-balance.js";

export interface LumenBalanceProps {
  /** The Stellar wallet address to display the balance for. */
  walletId: string;
  /** Asset code to display (e.g. "USDC"). Defaults to native XLM. */
  assetCode?: string;
  /** Auto-refresh interval in milliseconds. Set to 0 to disable. Defaults to 10 000. */
  refreshInterval?: number;
  /** Additional CSS class name(s) for the root element. */
  className?: string;
  /** Render prop — receives the resolved balance string and renders it. */
  renderBalance?: (balance: string) => React.ReactNode;
  /** Render prop — renders the loading skeleton. */
  renderLoading?: () => React.ReactNode;
  /** Render prop — renders the error state. */
  renderError?: (error: Error) => React.ReactNode;
  /** Props forwarded to the refresh button. */
  refreshButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
}

/**
 * Displays the balance for a wallet address.
 * Renders a refresh button and supports loading/error states via render props
 * or accessible defaults.
 */
export function LumenBalance({
  walletId,
  assetCode,
  refreshInterval,
  className,
  renderBalance,
  renderLoading,
  renderError,
  refreshButtonProps,
}: LumenBalanceProps): React.ReactElement {
  const { balance, loading, error, refetch } = useBalance(walletId, assetCode, refreshInterval);

  const { className: refreshBtnClassName, ...restRefreshButtonProps } = refreshButtonProps ?? {};

  const handleRefresh = async () => {
    await refetch();
  };

  const renderContent = () => {
    if (loading && balance === undefined) {
      if (renderLoading) {
        return renderLoading();
      }
      return (
        <span
          className="lumen-balance__skeleton"
          aria-busy="true"
          aria-label="Loading balance…"
          role="status"
          style={{
            display: "inline-block",
            width: "6em",
            height: "1em",
            background: "linear-gradient(90deg, #e0e0e0 25%, #f0f0f0 50%, #e0e0e0 75%)",
            backgroundSize: "200% 100%",
            borderRadius: "4px",
            animation: "lumen-shimmer 1.4s infinite",
          }}
        />
      );
    }

    if (error) {
      if (renderError) {
        return renderError(error);
      }
      return (
        <span className="lumen-balance__error" role="alert" style={{ color: "#c0392b" }}>
          {error.message}
        </span>
      );
    }

    const displayBalance = balance ?? "—";
    const displayAsset = assetCode ?? "XLM";

    if (renderBalance) {
      return renderBalance(displayBalance);
    }

    return (
      <span className="lumen-balance__value">
        {displayBalance}{" "}
        <span className="lumen-balance__asset" aria-label={displayAsset}>
          {displayAsset}
        </span>
      </span>
    );
  };

  return (
    <div className={["lumen-balance", className].filter(Boolean).join(" ")}>
      {renderContent()}
      <button
        type="button"
        aria-label="Refresh balance"
        onClick={() => {
          void handleRefresh();
        }}
        disabled={loading}
        className={["lumen-balance__refresh-btn", refreshBtnClassName].filter(Boolean).join(" ")}
        {...restRefreshButtonProps}
      >
        ↻
      </button>
    </div>
  );
}
