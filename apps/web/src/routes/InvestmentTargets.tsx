/**
 * InvestmentTargets — single-page form for setting the target
 * allocation percentages by asset class. Server enforces SUM == 100.
 *
 * The form pre-populates every asset class with the current target (or
 * blank), and the live sum runs at the bottom — green when 100, amber
 * otherwise. Submit is disabled until the sum is in the [99.99, 100.01]
 * tolerance band.
 */
import { useEffect, useState } from "react";
import { LoadingBox } from "@/components/LoadingScreen";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { apiFetch, ApiError } from "@/lib/api";
import type {
  AssetClass,
  TargetAllocationRow,
  TargetAllocationsPut,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ASSET_CLASSES,
  labelForAssetClass,
} from "@/lib/assetClass";

const SUM_TOLERANCE = 0.01;

export function InvestmentTargets() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useQuery<TargetAllocationRow[]>({
    queryKey: ["investment-targets"],
    queryFn: () =>
      apiFetch<TargetAllocationRow[]>("/investments/targets/"),
  });

  // Local form state — every asset class has a string slot.
  const [pcts, setPcts] = useState<Record<AssetClass, string>>(() => {
    return Object.fromEntries(
      ASSET_CLASSES.map((c) => [c, ""]),
    ) as Record<AssetClass, string>;
  });
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = Object.fromEntries(
      ASSET_CLASSES.map((c) => [c, ""]),
    ) as Record<AssetClass, string>;
    for (const row of data) {
      next[row.asset_class] = String(row.target_pct);
    }
    setPcts(next);
  }, [data]);

  const sum = ASSET_CLASSES.reduce((acc, c) => {
    const n = Number(pcts[c]);
    return acc + (Number.isNaN(n) ? 0 : n);
  }, 0);
  const sumValid = Math.abs(sum - 100) <= SUM_TOLERANCE;

  const saveMutation = useMutation<
    TargetAllocationRow[],
    ApiError,
    TargetAllocationsPut
  >({
    mutationFn: (body) =>
      apiFetch<TargetAllocationRow[]>("/investments/targets/", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setServerError(null);
      setSavedAt(Date.now());
      void queryClient.invalidateQueries({
        queryKey: ["investment-targets"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["investments-portfolio"],
      });
    },
    onError: (err) => setServerError(extractError(err)),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sumValid) return;
    const targets: TargetAllocationRow[] = [];
    for (const c of ASSET_CLASSES) {
      const n = Number(pcts[c]);
      if (!Number.isNaN(n) && n > 0) {
        targets.push({ asset_class: c, target_pct: n });
      }
    }
    saveMutation.mutate({ targets });
  }

  function patch(c: AssetClass, v: string) {
    setPcts((s) => ({ ...s, [c]: v }));
    setSavedAt(null);
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">Target allocation</h2>
            <p className="text-sm text-muted-foreground">
              Set the percentage of your portfolio you want in each asset
              class. Drift from these targets shows up on the Overview.
            </p>
          </div>
          <Link
            to="/investments"
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            ← Back to overview
          </Link>
        </div>

        {isLoading && <LoadingBox />}
        {isError && (
          <p className="text-destructive">Failed to load targets.</p>
        )}

        <Card>
          <CardContent className="p-4">
            <form onSubmit={handleSubmit} className="space-y-3">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="py-2 text-left font-medium">Asset class</th>
                    <th className="py-2 text-right font-medium">Target %</th>
                  </tr>
                </thead>
                <tbody>
                  {ASSET_CLASSES.map((c) => (
                    <tr
                      key={c}
                      className="border-b border-border/50 last:border-b-0"
                    >
                      <td className="py-2 pr-2">{labelForAssetClass(c)}</td>
                      <td className="py-2">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          max="100"
                          value={pcts[c]}
                          onChange={(e) => patch(c, e.target.value)}
                          className="ml-auto w-28 text-right tabular-nums"
                          placeholder="0"
                        />
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-border">
                    <td className="py-2 font-semibold">Sum</td>
                    <td className="py-2 text-right">
                      <span
                        className={
                          "tabular-nums font-semibold " +
                          (sumValid
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400")
                        }
                      >
                        {sum.toFixed(2)}%
                      </span>
                      {!sumValid && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (must equal 100)
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>

              <div className="flex items-center gap-3 pt-2">
                <Button
                  type="submit"
                  disabled={!sumValid || saveMutation.isPending}
                >
                  {saveMutation.isPending ? "Saving…" : "Save targets"}
                </Button>
                {savedAt !== null && sumValid && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                    ✓ saved
                  </span>
                )}
                {serverError && (
                  <span className="text-sm text-destructive" role="alert">
                    {serverError}
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function extractError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body;
    if (body && typeof body === "object" && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") return detail;
      if (detail && typeof detail === "object" && "message" in detail) {
        return String((detail as { message: unknown }).message);
      }
    }
    return `Server error ${err.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}
