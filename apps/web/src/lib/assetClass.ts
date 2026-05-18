import type { AssetClass } from "@/types/api";

/**
 * Shared labels + ordering for the AssetClass enum. Used by the
 * Holdings form (dropdown), Targets form, Portfolio overview (rows),
 * and any future allocation visual.
 */
export const ASSET_CLASSES: readonly AssetClass[] = [
  "equity_ca",
  "equity_us",
  "equity_international",
  "bonds",
  "cash",
  "alternative",
  "real_estate",
  "crypto",
  "other",
] as const;

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity_ca: "Equities (Canada)",
  equity_us: "Equities (US)",
  equity_international: "Equities (International)",
  bonds: "Bonds & Fixed Income",
  cash: "Cash & equivalents",
  alternative: "Alternative",
  real_estate: "Real estate",
  crypto: "Crypto",
  other: "Other",
};

export function labelForAssetClass(value: AssetClass | string): string {
  return ASSET_CLASS_LABELS[value as AssetClass] ?? value;
}
