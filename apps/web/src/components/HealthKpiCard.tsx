/**
 * HealthKpiCard — reusable score-card tile for the Money dashboard.
 *
 * Renders a single financial-health KPI with its target line and a
 * six-dot pip indicator. Colour reflects the `status` field from
 * `GET /money/health` so the dashboard reads as a stoplight without
 * the caller having to do its own threshold math.
 *
 *   above  → emerald (target met or exceeded)
 *   at     → amber   (within 80–100% of target / within 120% for D-to-I)
 *   below  → red     (off-target)
 *   unavailable → muted, value shown as "—" with the reason below
 */
import type { HealthStatus } from "@/types/api";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface HealthKpiCardProps {
  label: string;
  value: number | null;
  /** Suffix appended to the value, e.g. "%", "mo". */
  unit?: string;
  /** Pre-formatted target string (e.g. "20%", "<30%", "≥3"). */
  targetLabel: string;
  status: HealthStatus;
  /** Empty-state copy when value is null. */
  reason?: string | null;
  /** Decimal places when rendering the value. */
  fractionDigits?: number;
}

const STATUS_COLOR: Record<HealthStatus, string> = {
  above: "text-emerald-500 dark:text-emerald-400",
  at: "text-amber-500 dark:text-amber-400",
  below: "text-red-500 dark:text-red-400",
  unavailable: "text-muted-foreground",
};

const STATUS_PIP_FILLED: Record<HealthStatus, string> = {
  above: "bg-emerald-500 dark:bg-emerald-400",
  at: "bg-amber-500 dark:bg-amber-400",
  below: "bg-red-500 dark:bg-red-400",
  unavailable: "bg-muted-foreground/40",
};

const STATUS_PIP_EMPTY = "bg-muted";

/** Fill N of 6 dots based on how close `value` is to `target`. */
function pipFillCount(
  value: number | null,
  target: number,
  inverted: boolean,
): number {
  if (value === null || target <= 0) return 0;
  // For lower-is-better metrics (debt-to-income), invert the ratio so
  // a value under target fills more pips.
  const ratio = inverted ? target / value : value / target;
  const clamped = Math.max(0, Math.min(1.2, ratio));
  return Math.round(clamped * 6);
}

export function HealthKpiCard({
  label,
  value,
  unit,
  targetLabel,
  status,
  reason,
  fractionDigits = 1,
}: HealthKpiCardProps) {
  // Pip math is decorative; the router already encodes the truth in
  // `status`. We just need a sensible scale for the bar.
  const filledPips = pipFillCount(
    value,
    Number(targetLabel.replace(/[^\d.]/g, "")) || 1,
    targetLabel.includes("<"),
  );

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "mt-1 text-2xl font-bold tabular-nums",
            STATUS_COLOR[status],
          )}
        >
          {value === null
            ? "—"
            : `${value.toFixed(fractionDigits)}${unit ?? ""}`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Target {targetLabel}
        </p>
        <div className="mt-3 flex gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                i < filledPips ? STATUS_PIP_FILLED[status] : STATUS_PIP_EMPTY,
              )}
            />
          ))}
        </div>
        {reason && status === "unavailable" && (
          <p className="mt-2 text-xs text-muted-foreground">{reason}</p>
        )}
      </CardContent>
    </Card>
  );
}
