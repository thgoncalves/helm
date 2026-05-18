import type { InvestmentAccountKind } from "@/types/api";

export const ACCOUNT_KINDS: readonly InvestmentAccountKind[] = [
  "itrade",
  "rrsp",
  "tfsa",
  "brazil",
  "corp",
] as const;

export const ACCOUNT_KIND_LABELS: Record<InvestmentAccountKind, string> = {
  itrade: "Scotia iTrade (taxable)",
  rrsp: "RRSP",
  tfsa: "TFSA",
  brazil: "Brazilian (BRL)",
  corp: "Corp / business",
};

export function labelForAccountKind(
  value: InvestmentAccountKind | string,
): string {
  return ACCOUNT_KIND_LABELS[value as InvestmentAccountKind] ?? value;
}
