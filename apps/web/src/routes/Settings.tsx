/**
 * Settings page — Company Information, Tax Rates, Invoice Settings,
 * User Contact (for PDFs), and Theme.
 *
 * Folder/Backup section from the legacy app is intentionally gone:
 * the database lives in Aurora (managed) and PDFs are streamed
 * directly from the API (no folder concept). The user can download
 * the latest PDF from each respective page.
 *
 * Persistence: every editable input is keyed against a settings table
 * row. Save sends a PUT /business/settings/ with just the diff.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import {
  applyTheme,
  isTheme,
  saveTheme,
  Theme,
  THEMES,
  THEME_LABELS,
} from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader } from "@/components/AppHeader";

type SettingsMap = Record<string, string>;

/** Form-state keys — each maps to a row in the settings table. */
const FIELDS = [
  "company_name",
  "company_abn",
  "gst_rate",
  "transfer_tax_rate_company",
  "transfer_tax_rate_personal",
  "invoice_number_prefix",
  "default_payment_terms",
  "default_currency",
  "user_full_name",
  "user_address",
  "user_postal_code",
  "user_phone",
  "user_email",
  "etransfer_email",
  "theme",
] as const;
type FieldKey = (typeof FIELDS)[number];

type FormState = Record<FieldKey, string>;

function emptyState(): FormState {
  return Object.fromEntries(FIELDS.map((k) => [k, ""])) as FormState;
}

function fromMap(map: SettingsMap): FormState {
  const out = emptyState();
  for (const k of FIELDS) {
    if (k in map) out[k] = map[k] ?? "";
  }
  // Default the theme to the persisted value or "default".
  if (!out.theme) out.theme = "default";
  return out;
}

/**
 * Build the diff between the saved baseline and the form state — only
 * changed keys go to the server.
 */
function diff(baseline: FormState, current: FormState): SettingsMap {
  const out: SettingsMap = {};
  for (const k of FIELDS) {
    if ((baseline[k] ?? "") !== (current[k] ?? "")) {
      out[k] = current[k];
    }
  }
  return out;
}

/** Parse a percentage string ("5", "5%", "5.0%") into "0.0500" form. */
function percentToDecimal(input: string): string {
  const cleaned = input.trim().replace(/%/g, "");
  if (cleaned === "") return "";
  const n = Number(cleaned);
  if (Number.isNaN(n)) return input;
  return (n / 100).toString();
}

/** Render a decimal rate as "5.0%". */
function decimalToPercent(decimalStr: string): string {
  if (!decimalStr) return "";
  const n = Number(decimalStr);
  if (Number.isNaN(n)) return decimalStr;
  return `${(n * 100).toFixed(1)}%`;
}

export function Settings() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<SettingsMap>({
    queryKey: ["settings"],
    queryFn: () => apiFetch<SettingsMap>("/business/settings/"),
  });

  const [baseline, setBaseline] = useState<FormState>(emptyState);
  const [state, setState] = useState<FormState>(emptyState);
  // Tax rates are shown as percentages but stored as decimals.
  const [rateInputs, setRateInputs] = useState<{
    gst_rate: string;
    transfer_tax_rate_company: string;
    transfer_tax_rate_personal: string;
  }>({
    gst_rate: "",
    transfer_tax_rate_company: "",
    transfer_tax_rate_personal: "",
  });

  useEffect(() => {
    if (!data) return;
    const next = fromMap(data);
    setBaseline(next);
    setState(next);
    setRateInputs({
      gst_rate: decimalToPercent(next.gst_rate),
      transfer_tax_rate_company: decimalToPercent(next.transfer_tax_rate_company),
      transfer_tax_rate_personal: decimalToPercent(next.transfer_tax_rate_personal),
    });
  }, [data]);

  const dirty = useMemo(() => diff(baseline, state), [baseline, state]);
  const hasChanges = Object.keys(dirty).length > 0;

  const saveMutation = useMutation<SettingsMap, ApiError, SettingsMap>({
    mutationFn: (payload) =>
      apiFetch<SettingsMap>("/business/settings/", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: (saved) => {
      const next = fromMap(saved);
      setBaseline(next);
      setState(next);
      // Update the rate inputs in case the server normalised the value.
      setRateInputs({
        gst_rate: decimalToPercent(next.gst_rate),
        transfer_tax_rate_company: decimalToPercent(next.transfer_tax_rate_company),
        transfer_tax_rate_personal: decimalToPercent(next.transfer_tax_rate_personal),
      });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["transfer-tax-rates"] });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!hasChanges) return;
    saveMutation.mutate(dirty);
  }

  function patch(key: FieldKey, value: string) {
    setState((s) => ({ ...s, [key]: value }));
  }

  /** Theme is applied live so the user can preview without saving. */
  function patchTheme(value: string) {
    patch("theme", value);
    if (isTheme(value)) {
      applyTheme(value);
      saveTheme(value);
    }
  }

  function patchRate(
    key: "gst_rate" | "transfer_tax_rate_company" | "transfer_tax_rate_personal",
    pretty: string,
  ) {
    setRateInputs((r) => ({ ...r, [key]: pretty }));
    patch(key, percentToDecimal(pretty));
  }

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-3xl px-4 py-6">
        <h2 className="mb-6 text-2xl font-bold">Settings</h2>

        {isLoading && (
          <p className="text-muted-foreground">Loading settings…</p>
        )}
        {isError && (
          <p className="text-destructive">
            Failed to load settings:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        )}

        {!isLoading && !isError && (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Company Information</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
                <Label htmlFor="company_name">Company Name</Label>
                <Input
                  id="company_name"
                  value={state.company_name}
                  onChange={(e) => patch("company_name", e.target.value)}
                />

                <Label htmlFor="company_abn">Business Number</Label>
                <Input
                  id="company_abn"
                  placeholder="GST / business registration number"
                  value={state.company_abn}
                  onChange={(e) => patch("company_abn", e.target.value)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Tax Rates</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[260px_1fr] sm:items-center">
                <Label htmlFor="gst_rate">GST Rate</Label>
                <Input
                  id="gst_rate"
                  placeholder="5.0%"
                  value={rateInputs.gst_rate}
                  onChange={(e) => patchRate("gst_rate", e.target.value)}
                />

                <Label htmlFor="transfer_tax_rate_company">
                  Company Tax Rate (Transfers)
                </Label>
                <Input
                  id="transfer_tax_rate_company"
                  placeholder="30.0%"
                  value={rateInputs.transfer_tax_rate_company}
                  onChange={(e) =>
                    patchRate("transfer_tax_rate_company", e.target.value)
                  }
                />

                <Label htmlFor="transfer_tax_rate_personal">
                  Personal Tax Rate (Transfers)
                </Label>
                <Input
                  id="transfer_tax_rate_personal"
                  placeholder="32.5%"
                  value={rateInputs.transfer_tax_rate_personal}
                  onChange={(e) =>
                    patchRate("transfer_tax_rate_personal", e.target.value)
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Invoice Settings</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
                <Label htmlFor="invoice_number_prefix">
                  Invoice Number Prefix
                </Label>
                <Input
                  id="invoice_number_prefix"
                  placeholder="INV"
                  value={state.invoice_number_prefix}
                  onChange={(e) =>
                    patch("invoice_number_prefix", e.target.value)
                  }
                />

                <Label htmlFor="default_payment_terms">
                  Default Payment Terms
                </Label>
                <Input
                  id="default_payment_terms"
                  placeholder="Net 30"
                  value={state.default_payment_terms}
                  onChange={(e) =>
                    patch("default_payment_terms", e.target.value)
                  }
                />

                <Label htmlFor="default_currency">Default Currency</Label>
                <Input
                  id="default_currency"
                  placeholder="CAD"
                  maxLength={3}
                  value={state.default_currency}
                  onChange={(e) =>
                    patch("default_currency", e.target.value.toUpperCase())
                  }
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  User Contact (printed on PDFs)
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
                <Label htmlFor="user_full_name">Full Name</Label>
                <Input
                  id="user_full_name"
                  value={state.user_full_name}
                  onChange={(e) => patch("user_full_name", e.target.value)}
                />
                <Label htmlFor="user_address">Address</Label>
                <Input
                  id="user_address"
                  value={state.user_address}
                  onChange={(e) => patch("user_address", e.target.value)}
                />
                <Label htmlFor="user_postal_code">Postal Code</Label>
                <Input
                  id="user_postal_code"
                  value={state.user_postal_code}
                  onChange={(e) => patch("user_postal_code", e.target.value)}
                />
                <Label htmlFor="user_phone">Phone</Label>
                <Input
                  id="user_phone"
                  value={state.user_phone}
                  onChange={(e) => patch("user_phone", e.target.value)}
                />
                <Label htmlFor="user_email">Email</Label>
                <Input
                  id="user_email"
                  type="email"
                  value={state.user_email}
                  onChange={(e) => patch("user_email", e.target.value)}
                />
                <Label htmlFor="etransfer_email">e-Transfer Email</Label>
                <Input
                  id="etransfer_email"
                  type="email"
                  placeholder="Shown in the invoice PDF footer"
                  value={state.etransfer_email}
                  onChange={(e) => patch("etransfer_email", e.target.value)}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Appearance</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_1fr] sm:items-center">
                <Label htmlFor="theme">Theme</Label>
                <select
                  id="theme"
                  className={
                    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
                    "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
                    "focus-visible:ring-ring focus-visible:ring-offset-2"
                  }
                  value={state.theme || "default"}
                  onChange={(e) => patchTheme(e.target.value)}
                >
                  {THEMES.map((t) => (
                    <option key={t} value={t}>
                      {THEME_LABELS[t as Theme]}
                    </option>
                  ))}
                </select>
              </CardContent>
            </Card>

            {/* Where things used to be: folder paths + database backup. */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  Data Storage (read-only)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p>
                  <strong>Database:</strong> Aurora Serverless v2
                  (managed). Backups are taken automatically by AWS.
                </p>
                <p>
                  <strong>Timesheet PDFs:</strong> generated on demand —
                  use the "Export PDF" button on the Timesheets page.
                </p>
                <p>
                  <strong>Invoice PDFs:</strong> generated on demand — use
                  the "Download PDF" button on the Invoice edit page.
                </p>
              </CardContent>
            </Card>

            {saveMutation.isError && (
              <p className="text-sm text-destructive">
                Save failed:{" "}
                {saveMutation.error instanceof ApiError
                  ? typeof saveMutation.error.body === "object" &&
                    saveMutation.error.body &&
                    "detail" in saveMutation.error.body
                    ? String(
                        (saveMutation.error.body as { detail: unknown })
                          .detail,
                      )
                    : `Server error ${saveMutation.error.status}`
                  : String(saveMutation.error)}
              </p>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={!hasChanges || saveMutation.isPending}
              >
                {saveMutation.isPending ? "Saving…" : "Save Settings"}
              </Button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
