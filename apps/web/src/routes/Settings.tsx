/**
 * Settings page — three-zone layout with sidebar nav, scroll-spy, per-section
 * save buttons, and a ThemeCard grid picker.
 *
 * Layout: AppHeader on top, then a flex row that fills remaining height.
 * Left: <aside w-60> with search + section nav. Right: overflow-y-auto main
 * scroller. Each section has its own dirty flag and Save button.
 *
 * Persistence: PUT /business/settings/ with only the diff for the section
 * being saved.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  albertaHolidays,
  HolidayEntry,
  parseCustomHolidays,
  parseVacations,
  serializeCustomHolidays,
  serializeVacations,
  VacationPeriod,
} from "@/lib/holidays";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader } from "@/components/AppHeader";
import type { YnabStatusResponse } from "@/types/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SettingsMap = Record<string, string>;

/** All keys that map to rows in the settings table. */
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
  "custom_holidays",
  "vacations",
] as const;
type FieldKey = (typeof FIELDS)[number];
type FormState = Record<FieldKey, string>;

// ---------------------------------------------------------------------------
// Section metadata — single source of truth for nav + search + render
// ---------------------------------------------------------------------------

interface SectionMeta {
  id: string;
  title: string;
  keywords: string[];
  /** The FieldKey subsets that belong to this section. */
  fields: FieldKey[];
}

const SECTIONS: SectionMeta[] = [
  {
    id: "theme",
    title: "Theme",
    keywords: ["palette", "appearance", "dark", "light", "color"],
    fields: ["theme"],
  },
  {
    id: "company",
    title: "Company",
    keywords: ["company", "business", "name", "abn", "gst", "number"],
    fields: ["company_name", "company_abn"],
  },
  {
    id: "taxes",
    title: "Tax rates",
    keywords: ["tax", "gst", "rate", "transfer", "personal", "corporate"],
    fields: ["gst_rate", "transfer_tax_rate_company", "transfer_tax_rate_personal"],
  },
  {
    id: "invoices",
    title: "Invoice defaults",
    keywords: ["invoice", "number", "prefix", "terms", "payment", "currency"],
    fields: ["invoice_number_prefix", "default_payment_terms", "default_currency"],
  },
  {
    id: "user-contact",
    title: "Contact (PDFs)",
    keywords: ["contact", "name", "address", "postal", "phone", "email", "etransfer"],
    fields: [
      "user_full_name",
      "user_address",
      "user_postal_code",
      "user_phone",
      "user_email",
      "etransfer_email",
    ],
  },
  {
    id: "holidays",
    title: "Holidays & vacation",
    keywords: [
      "holiday",
      "vacation",
      "time off",
      "alberta",
      "stat",
      "statutory",
      "custom",
    ],
    fields: ["custom_holidays", "vacations"],
  },
  {
    id: "ynab",
    title: "YNAB",
    keywords: [
      "ynab",
      "you need a budget",
      "money",
      "budget",
      "token",
      "personal access token",
      "pat",
      "integration",
    ],
    fields: [],
  },
  {
    id: "data-storage",
    title: "Data storage",
    keywords: ["data", "storage", "aurora", "database", "backup", "pdf"],
    fields: [],
  },
];

// ---------------------------------------------------------------------------
// Theme swatches for ThemeCard previews
// ---------------------------------------------------------------------------

const THEME_SWATCHES: Record<Theme, { app: string; surface: string; accent: string; warning: string; danger: string }> = {
  default: {
    app: "#ffffff",
    surface: "#f4f4f5",
    accent: "#2563eb",
    warning: "#d97706",
    danger: "#dc2626",
  },
  catppuccin: {
    app: "#1e1e2e",
    surface: "#181825",
    accent: "#89b4fa",
    warning: "#fab387",
    danger: "#f38ba8",
  },
  "tokyo-night": {
    app: "#1a1b26",
    surface: "#16161e",
    accent: "#7aa2f7",
    warning: "#e0af68",
    danger: "#f7768e",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState(): FormState {
  return Object.fromEntries(FIELDS.map((k) => [k, ""])) as FormState;
}

function fromMap(map: SettingsMap): FormState {
  const out = emptyState();
  for (const k of FIELDS) {
    if (k in map) out[k] = map[k] ?? "";
  }
  if (!out.theme) out.theme = "default";
  return out;
}

/** Return only the keys in `fieldSubset` that changed between baseline and current. */
function diffSubset(
  baseline: FormState,
  current: FormState,
  fieldSubset: FieldKey[],
): SettingsMap {
  const out: SettingsMap = {};
  for (const k of fieldSubset) {
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

/** Substring-AND search: every whitespace token must appear in the haystack. */
function matchesQuery(meta: SectionMeta, q: string): boolean {
  if (!q) return true;
  const haystack = (meta.title + " " + meta.keywords.join(" ")).toLowerCase();
  return q
    .split(/\s+/)
    .filter(Boolean)
    .every((tok) => haystack.includes(tok));
}

// ---------------------------------------------------------------------------
// ThemeCard component
// ---------------------------------------------------------------------------

interface ThemeCardProps {
  theme: Theme;
  active: boolean;
  onSelect: () => void;
}

function ThemeCard({ theme, active, onSelect }: ThemeCardProps) {
  const swatch = THEME_SWATCHES[theme];
  const label = THEME_LABELS[theme];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      aria-label={`Select ${label} theme`}
      className={[
        "text-left p-2 rounded-lg border transition-all",
        active
          ? "border-primary ring-2 ring-primary/40 bg-muted/30"
          : "border-border hover:border-input bg-card",
      ].join(" ")}
    >
      {/* Mini app window preview */}
      <div
        className="h-7 rounded mb-1.5 flex items-center px-1.5 gap-1"
        style={{
          background: swatch.app,
          border: `1px solid ${swatch.surface}`,
        }}
      >
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: swatch.accent }}
        />
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: swatch.warning }}
        />
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: swatch.danger }}
        />
      </div>
      <span className="text-xs text-foreground font-semibold truncate block">
        {label}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section save footer
// ---------------------------------------------------------------------------

interface SectionFooterProps {
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  error: string | null;
  onSave: () => void;
}

function SectionFooter({ dirty, saving, savedAt, error, onSave }: SectionFooterProps) {
  return (
    <div className="mt-4 flex items-center gap-3">
      <button
        type="button"
        onClick={onSave}
        disabled={!dirty || saving}
        className={[
          "px-3 py-1.5 rounded text-sm font-medium transition",
          "bg-primary text-primary-foreground",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "hover:bg-primary/90",
        ].join(" ")}
      >
        {saving ? "saving…" : "save"}
      </button>
      {savedAt !== null && !dirty && (
        <span className="text-xs text-emerald-600 dark:text-emerald-400">
          ✓ saved
        </span>
      )}
      {dirty && (
        <span className="text-xs text-amber-600 dark:text-amber-400">
          ⚠ unsaved changes
        </span>
      )}
      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// YNAB integration section
// ---------------------------------------------------------------------------

/**
 * YnabSection — self-contained widget for managing the YNAB integration.
 *
 * Lives inside the standard Settings page but talks to its own endpoints
 * (``/money/integrations/ynab/*``) rather than the business settings PUT,
 * because the YNAB Personal Access Token must never land in the
 * ``settings`` key/value table — it lives in AWS Secrets Manager.
 */
function YnabSection() {
  const queryClient = useQueryClient();
  const statusQ = useQuery<YnabStatusResponse>({
    queryKey: ["money-ynab-status"],
    queryFn: () =>
      apiFetch<YnabStatusResponse>("/money/integrations/ynab/status"),
  });

  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  /** When connected, the input box is hidden behind a "Rotate token"
   *  button so the empty `<Input>` doesn't read as "Helm forgot my token". */
  const [rotating, setRotating] = useState(false);

  const saveMutation = useMutation<YnabStatusResponse, ApiError, string>({
    mutationFn: (raw) =>
      apiFetch<YnabStatusResponse>("/money/integrations/ynab/token", {
        method: "PUT",
        body: JSON.stringify({ token: raw }),
      }),
    onSuccess: () => {
      setToken("");
      setRotating(false);
      setError(null);
      setSuccess("Connected — initial sync ran successfully.");
      void queryClient.invalidateQueries({ queryKey: ["money-ynab-status"] });
      void queryClient.invalidateQueries({ queryKey: ["money-dashboard"] });
    },
    onError: (err) => {
      setSuccess(null);
      setError(extractErrorMessage(err));
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ updated_at: string }>("/money/ynab/refresh", {
        method: "POST",
      }),
    onSuccess: () => {
      setError(null);
      setSuccess("Refreshed.");
      void queryClient.invalidateQueries({ queryKey: ["money-ynab-status"] });
      void queryClient.invalidateQueries({ queryKey: ["money-dashboard"] });
    },
    onError: (err) => {
      setSuccess(null);
      setError(extractErrorMessage(err));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      apiFetch<YnabStatusResponse>("/money/integrations/ynab/token", {
        method: "DELETE",
      }),
    onSuccess: () => {
      setError(null);
      setRotating(false);
      setToken("");
      setSuccess("Disconnected.");
      void queryClient.invalidateQueries({ queryKey: ["money-ynab-status"] });
      void queryClient.invalidateQueries({ queryKey: ["money-dashboard"] });
    },
    onError: (err) => {
      setSuccess(null);
      setError(extractErrorMessage(err));
    },
  });

  const status = statusQ.data;
  const connected = status?.token_configured === true;

  return (
    <section id="ynab" className="scroll-mt-4">
      <h2 className="mb-1 text-lg font-semibold text-foreground">YNAB</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Helm reads your budget from YNAB on demand using a Personal Access
        Token. In production the token lives in AWS Secrets Manager; in
        local dev it sits in <code>~/.helm/local/ynab-token</code> with
        owner-only perms. Either way it's never in the database, and
        never echoed back to the browser.
      </p>

      <div className="space-y-4">
        {statusQ.isLoading && (
          <p className="text-sm text-muted-foreground">Loading status…</p>
        )}

        {!statusQ.isLoading && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span
              className={[
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                connected
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200"
                  : "bg-muted text-muted-foreground",
              ].join(" ")}
            >
              <span
                className={[
                  "h-1.5 w-1.5 rounded-full",
                  connected ? "bg-emerald-500" : "bg-muted-foreground/50",
                ].join(" ")}
              />
              {connected ? "Connected" : "Not connected"}
            </span>
            {status?.active_budget_name && (
              <span className="text-muted-foreground">
                Active budget:{" "}
                <span className="font-medium text-foreground">
                  {status.active_budget_name}
                </span>
              </span>
            )}
            {status?.last_synced_at && (
              <span className="text-muted-foreground">
                Last synced{" "}
                <span className="font-medium text-foreground">
                  {new Date(status.last_synced_at).toLocaleString("en-CA")}
                </span>
              </span>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="ynab-token">
            Personal Access Token (
            <a
              className="underline"
              href="https://app.ynab.com/settings/developer"
              target="_blank"
              rel="noopener noreferrer"
            >
              get one
            </a>
            )
          </Label>

          {connected && !rotating ? (
            /* Connected, not rotating — show a "stored" chip instead of
               an empty input box. The token can't be echoed back (it
               lives in Secrets Manager); the chip removes the
               "did Helm forget my token?" confusion. */
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <span className="inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm font-mono text-muted-foreground sm:flex-1">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                  aria-hidden
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span aria-label="Token stored — hidden">
                  •••• •••• •••• ••••
                </span>
                <span className="ml-auto text-xs uppercase tracking-wide">
                  stored
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRotating(true);
                  setToken("");
                  setSuccess(null);
                  setError(null);
                }}
              >
                Rotate token
              </Button>
            </div>
          ) : (
            /* Disconnected, OR connected + rotating — show the input. */
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="ynab-token"
                type="password"
                autoComplete="off"
                placeholder={
                  connected
                    ? "Paste the replacement token"
                    : "Paste your YNAB PAT"
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="sm:flex-1"
                autoFocus={rotating}
              />
              <Button
                type="button"
                onClick={() => saveMutation.mutate(token)}
                disabled={!token.trim() || saveMutation.isPending}
              >
                {saveMutation.isPending
                  ? "Connecting…"
                  : connected
                  ? "Save new token"
                  : "Connect"}
              </Button>
              {connected && rotating && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setRotating(false);
                    setToken("");
                    setError(null);
                  }}
                  disabled={saveMutation.isPending}
                >
                  Cancel
                </Button>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            We verify the token with a YNAB <code>/user</code> probe and
            run the first sync immediately. Rejected tokens are discarded.
          </p>
        </div>

        {connected && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? "Refreshing…" : "Refresh now"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {success && !error && (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {success}
          </p>
        )}
      </div>
    </section>
  );
}

/** Pull a human-readable message out of an ApiError or generic error. */
function extractErrorMessage(err: unknown): string {
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

// ---------------------------------------------------------------------------
// Main Settings component
// ---------------------------------------------------------------------------

export function Settings() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useQuery<SettingsMap>({
    queryKey: ["settings"],
    queryFn: () => apiFetch<SettingsMap>("/business/settings/"),
  });

  const [baseline, setBaseline] = useState<FormState>(emptyState);
  const [state, setState] = useState<FormState>(emptyState);

  // Tax rates are displayed as percentages but stored as decimals.
  const [rateInputs, setRateInputs] = useState<{
    gst_rate: string;
    transfer_tax_rate_company: string;
    transfer_tax_rate_personal: string;
  }>({ gst_rate: "", transfer_tax_rate_company: "", transfer_tax_rate_personal: "" });

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

  // Per-section saved timestamps & saving tracker
  const [savedAt, setSavedAt] = useState<Record<string, number | null>>({});
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] = useState<Record<string, string | null>>({});

  const saveMutation = useMutation<SettingsMap, ApiError, { sectionId: string; payload: SettingsMap }>({
    mutationFn: ({ payload }) =>
      apiFetch<SettingsMap>("/business/settings/", {
        method: "PUT",
        body: JSON.stringify(payload),
      }),
    onSuccess: (saved, { sectionId }) => {
      const next = fromMap(saved);
      setBaseline(next);
      setState(next);
      setRateInputs({
        gst_rate: decimalToPercent(next.gst_rate),
        transfer_tax_rate_company: decimalToPercent(next.transfer_tax_rate_company),
        transfer_tax_rate_personal: decimalToPercent(next.transfer_tax_rate_personal),
      });
      setSavedAt((s) => ({ ...s, [sectionId]: Date.now() }));
      setSavingSection(null);
      setSectionErrors((e) => ({ ...e, [sectionId]: null }));
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
      void queryClient.invalidateQueries({ queryKey: ["transfer-tax-rates"] });
    },
    onError: (err, { sectionId }) => {
      setSavingSection(null);
      const msg =
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : String(err);
      setSectionErrors((e) => ({ ...e, [sectionId]: msg }));
    },
  });

  function saveSection(sectionId: string, fields: FieldKey[]) {
    const payload = diffSubset(baseline, state, fields);
    if (Object.keys(payload).length === 0) return;
    setSavingSection(sectionId);
    setSavedAt((s) => ({ ...s, [sectionId]: null }));
    saveMutation.mutate({ sectionId, payload });
  }

  function patch(key: FieldKey, value: string) {
    setState((s) => ({ ...s, [key]: value }));
  }

  /** Theme applied live on selection — no save needed for visual feedback. */
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

  // Holidays / vacation state
  const customHolidays = useMemo(
    () => parseCustomHolidays(state.custom_holidays),
    [state.custom_holidays],
  );
  const vacations = useMemo(
    () => parseVacations(state.vacations),
    [state.vacations],
  );

  function updateCustomHolidays(next: HolidayEntry[]) {
    patch("custom_holidays", serializeCustomHolidays(next));
  }
  function updateVacations(next: VacationPeriod[]) {
    patch("vacations", serializeVacations(next));
  }

  const [newHoliday, setNewHoliday] = useState<{ date: string; name: string }>({
    date: "",
    name: "",
  });
  const [newVacation, setNewVacation] = useState<{
    start: string;
    end: string;
    label: string;
  }>({ start: "", end: "", label: "" });

  function addHoliday() {
    if (!newHoliday.date || !newHoliday.name.trim()) return;
    updateCustomHolidays(
      [
        ...customHolidays,
        { date: newHoliday.date, name: newHoliday.name.trim(), source: "custom" },
      ].sort((a, b) => a.date.localeCompare(b.date)),
    );
    setNewHoliday({ date: "", name: "" });
  }

  function removeHoliday(date: string) {
    updateCustomHolidays(customHolidays.filter((h) => h.date !== date));
  }

  function addVacation() {
    if (!newVacation.start || !newVacation.end || !newVacation.label.trim()) return;
    if (newVacation.end < newVacation.start) return;
    updateVacations(
      [
        ...vacations,
        {
          start: newVacation.start,
          end: newVacation.end,
          label: newVacation.label.trim(),
        },
      ].sort((a, b) => a.start.localeCompare(b.start)),
    );
    setNewVacation({ start: "", end: "", label: "" });
  }

  function removeVacation(index: number) {
    updateVacations(vacations.filter((_, i) => i !== index));
  }

  const currentYear = new Date().getFullYear();
  const referenceHolidays = useMemo(
    () => [
      ...albertaHolidays(currentYear),
      ...albertaHolidays(currentYear + 1),
    ],
    [currentYear],
  );

  // ---------------------------------------------------------------------------
  // Layout state: search + scroll-spy
  // ---------------------------------------------------------------------------

  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const spyLockUntilRef = useRef<number>(0);

  const visibleSections = useMemo(
    () => SECTIONS.filter((s) => matchesQuery(s, query)),
    [query],
  );
  const visibleIds = useMemo(
    () => new Set(visibleSections.map((s) => s.id)),
    [visibleSections],
  );

  // Scroll-spy effect
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root) return;
    const onScroll = () => {
      if (Date.now() < spyLockUntilRef.current) return;
      const rootTop = root.getBoundingClientRect().top;
      let active = SECTIONS[0].id;
      for (const s of SECTIONS) {
        if (!visibleIds.has(s.id)) continue;
        const el = document.getElementById(s.id);
        if (!el) continue;
        const top = el.getBoundingClientRect().top - rootTop;
        if (top <= 80) active = s.id;
      }
      setActiveId(active);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => root.removeEventListener("scroll", onScroll);
  }, [visibleIds]);

  const scrollToSection = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveId(id);
    spyLockUntilRef.current = Date.now() + 700;
  }, []);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  /** Whether a section has any unsaved changes. */
  function isSectionDirty(sectionId: string): boolean {
    const meta = SECTIONS.find((s) => s.id === sectionId);
    if (!meta) return false;
    return Object.keys(diffSubset(baseline, state, meta.fields)).length > 0;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AppHeader />

      <div className="flex flex-1 min-h-0">
        {/* ── Sidebar ── */}
        <aside className="w-60 shrink-0 border-r border-border flex flex-col min-h-0 hidden sm:flex">
          {/* Search */}
          <div className="p-3 border-b border-border">
            <input
              type="search"
              placeholder="Search settings…"
              value={query}
              onChange={(e) => setQuery(e.target.value.toLowerCase())}
              className={[
                "w-full rounded-md border border-input bg-background px-3 py-1.5",
                "text-sm placeholder:text-muted-foreground/70",
                "focus:outline-none focus:ring-2 focus:ring-ring",
              ].join(" ")}
              aria-label="Search settings"
            />
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto py-2" aria-label="Settings sections">
            {visibleSections.length === 0 && (
              <p className="px-4 py-2 text-xs text-muted-foreground">no matches</p>
            )}
            {visibleSections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => scrollToSection(s.id)}
                className={[
                  "w-full text-left px-4 py-1.5 text-sm transition",
                  "border-l-2",
                  activeId === s.id
                    ? "text-foreground font-semibold bg-muted/40 border-primary"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                ].join(" ")}
              >
                {s.title}
              </button>
            ))}
          </nav>
        </aside>

        {/* ── Main scroller ── */}
        <div
          ref={scrollerRef}
          className="flex-1 overflow-y-auto min-h-0"
        >
          <div className="px-6 py-6 space-y-10 max-w-5xl">

            {isLoading && (
              <p className="text-muted-foreground">Loading settings…</p>
            )}
            {isError && (
              <p className="text-destructive">
                Failed to load settings:{" "}
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            )}

            {/* Empty search state in main */}
            {!isLoading && !isError && visibleSections.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No settings match <code className="font-mono">{query}</code>.
              </p>
            )}

            {/* ── Theme ── */}
            {visibleIds.has("theme") && (
              <section id="theme" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">Theme</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Pick a colour palette. Changes apply instantly — no save required.
                </p>
                <div
                  className="grid gap-2"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}
                >
                  {THEMES.map((t) => (
                    <ThemeCard
                      key={t}
                      theme={t}
                      active={state.theme === t}
                      onSelect={() => patchTheme(t)}
                    />
                  ))}
                </div>
                {/* Theme is applied live; no dirty / save needed — but we still
                    persist the key to server when other changes go through. */}
              </section>
            )}

            {/* ── Company ── */}
            {visibleIds.has("company") && (
              <section id="company" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">Company</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Your legal business name and registration number, printed on every invoice.
                </p>
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
                >
                  <div className="space-y-1">
                    <Label htmlFor="company_name">Company Name</Label>
                    <Input
                      id="company_name"
                      value={state.company_name}
                      onChange={(e) => patch("company_name", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="company_abn">Business Number</Label>
                    <Input
                      id="company_abn"
                      placeholder="GST / business registration number"
                      value={state.company_abn}
                      onChange={(e) => patch("company_abn", e.target.value)}
                    />
                  </div>
                </div>
                <SectionFooter
                  dirty={isSectionDirty("company")}
                  saving={savingSection === "company"}
                  savedAt={savedAt["company"] ?? null}
                  error={sectionErrors["company"] ?? null}
                  onSave={() => saveSection("company", SECTIONS.find((s) => s.id === "company")!.fields)}
                />
              </section>
            )}

            {/* ── Tax rates ── */}
            {visibleIds.has("taxes") && (
              <section id="taxes" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">Tax rates</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Rates used when generating invoices and calculating transfer withholding.
                </p>
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
                >
                  <div className="space-y-1">
                    <Label htmlFor="gst_rate">GST Rate</Label>
                    <Input
                      id="gst_rate"
                      placeholder="5.0%"
                      value={rateInputs.gst_rate}
                      onChange={(e) => patchRate("gst_rate", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
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
                  </div>
                  <div className="space-y-1">
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
                  </div>
                </div>
                <SectionFooter
                  dirty={isSectionDirty("taxes")}
                  saving={savingSection === "taxes"}
                  savedAt={savedAt["taxes"] ?? null}
                  error={sectionErrors["taxes"] ?? null}
                  onSave={() => saveSection("taxes", SECTIONS.find((s) => s.id === "taxes")!.fields)}
                />
              </section>
            )}

            {/* ── Invoice defaults ── */}
            {visibleIds.has("invoices") && (
              <section id="invoices" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  Invoice defaults
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Applied automatically to every new invoice; overridable per invoice.
                </p>
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
                >
                  <div className="space-y-1">
                    <Label htmlFor="invoice_number_prefix">Invoice Number Prefix</Label>
                    <Input
                      id="invoice_number_prefix"
                      placeholder="INV"
                      value={state.invoice_number_prefix}
                      onChange={(e) => patch("invoice_number_prefix", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="default_payment_terms">Default Payment Terms</Label>
                    <Input
                      id="default_payment_terms"
                      placeholder="Net 30"
                      value={state.default_payment_terms}
                      onChange={(e) => patch("default_payment_terms", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
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
                  </div>
                </div>
                <SectionFooter
                  dirty={isSectionDirty("invoices")}
                  saving={savingSection === "invoices"}
                  savedAt={savedAt["invoices"] ?? null}
                  error={sectionErrors["invoices"] ?? null}
                  onSave={() => saveSection("invoices", SECTIONS.find((s) => s.id === "invoices")!.fields)}
                />
              </section>
            )}

            {/* ── Contact (PDFs) ── */}
            {visibleIds.has("user-contact") && (
              <section id="user-contact" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  Contact (PDFs)
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Your contact details as they appear in the header and footer of
                  generated PDFs.
                </p>
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}
                >
                  <div className="space-y-1">
                    <Label htmlFor="user_full_name">Full Name</Label>
                    <Input
                      id="user_full_name"
                      value={state.user_full_name}
                      onChange={(e) => patch("user_full_name", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="user_address">Address</Label>
                    <Input
                      id="user_address"
                      value={state.user_address}
                      onChange={(e) => patch("user_address", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="user_postal_code">Postal Code</Label>
                    <Input
                      id="user_postal_code"
                      value={state.user_postal_code}
                      onChange={(e) => patch("user_postal_code", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="user_phone">Phone</Label>
                    <Input
                      id="user_phone"
                      value={state.user_phone}
                      onChange={(e) => patch("user_phone", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="user_email">Email</Label>
                    <Input
                      id="user_email"
                      type="email"
                      value={state.user_email}
                      onChange={(e) => patch("user_email", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="etransfer_email">e-Transfer Email</Label>
                    <Input
                      id="etransfer_email"
                      type="email"
                      placeholder="Shown in the invoice PDF footer"
                      value={state.etransfer_email}
                      onChange={(e) => patch("etransfer_email", e.target.value)}
                    />
                  </div>
                </div>
                <SectionFooter
                  dirty={isSectionDirty("user-contact")}
                  saving={savingSection === "user-contact"}
                  savedAt={savedAt["user-contact"] ?? null}
                  error={sectionErrors["user-contact"] ?? null}
                  onSave={() =>
                    saveSection(
                      "user-contact",
                      SECTIONS.find((s) => s.id === "user-contact")!.fields,
                    )
                  }
                />
              </section>
            )}

            {/* ── Holidays & vacation ── */}
            {visibleIds.has("holidays") && (
              <section id="holidays" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  Holidays &amp; vacation
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Stat holidays and vacation periods are highlighted on the Timesheet.
                  Changes take effect on the next Timesheet refresh.
                </p>

                {/* Alberta statutory holidays (read-only) */}
                <div className="mb-6">
                  <p className="mb-2 text-sm font-medium text-foreground">
                    Alberta statutory holidays (auto, {currentYear}–{currentYear + 1})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {referenceHolidays.map((h) => (
                      <span
                        key={`${h.date}-${h.name}`}
                        className="inline-flex items-center gap-1 rounded-md bg-rose-100 px-2 py-1 text-xs text-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                        title={h.date}
                      >
                        <span className="font-medium">{h.name}</span>
                        <span className="text-rose-600/70 dark:text-rose-400/70">
                          {h.date}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>

                {/* Custom holidays */}
                <div className="mb-6">
                  <p className="mb-2 text-sm font-medium text-foreground">
                    Custom holidays
                  </p>
                  {customHolidays.length === 0 && (
                    <p className="mb-2 text-xs text-muted-foreground">
                      No custom holidays yet. Add company days off or
                      observed-but-not-statutory dates below.
                    </p>
                  )}
                  {customHolidays.length > 0 && (
                    <ul className="mb-3 divide-y rounded-md border">
                      {customHolidays.map((h) => (
                        <li
                          key={`${h.date}-${h.name}`}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <div>
                            <span className="font-medium">{h.name}</span>{" "}
                            <span className="text-muted-foreground">{h.date}</span>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeHoliday(h.date)}
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[160px_1fr_auto] sm:items-center">
                    <Input
                      type="date"
                      value={newHoliday.date}
                      onChange={(e) =>
                        setNewHoliday((s) => ({ ...s, date: e.target.value }))
                      }
                      aria-label="Holiday date"
                    />
                    <Input
                      placeholder="Holiday name (e.g. Office closure)"
                      value={newHoliday.name}
                      onChange={(e) =>
                        setNewHoliday((s) => ({ ...s, name: e.target.value }))
                      }
                      aria-label="Holiday name"
                    />
                    <Button
                      type="button"
                      onClick={addHoliday}
                      disabled={!newHoliday.date || !newHoliday.name.trim()}
                    >
                      Add holiday
                    </Button>
                  </div>
                </div>

                {/* Vacation periods */}
                <div className="mb-4">
                  <p className="mb-2 text-sm font-medium text-foreground">
                    Vacation periods
                  </p>
                  {vacations.length === 0 && (
                    <p className="mb-2 text-xs text-muted-foreground">
                      No vacation periods set. Add ranges of days off — the
                      Timesheet will tint those cells amber.
                    </p>
                  )}
                  {vacations.length > 0 && (
                    <ul className="mb-3 divide-y rounded-md border">
                      {vacations.map((v, i) => (
                        <li
                          key={`${v.start}-${v.end}-${v.label}`}
                          className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                        >
                          <div>
                            <span className="font-medium">{v.label}</span>{" "}
                            <span className="text-muted-foreground">
                              {v.start} → {v.end}
                            </span>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeVacation(i)}
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[150px_150px_1fr_auto] sm:items-center">
                    <Input
                      type="date"
                      value={newVacation.start}
                      onChange={(e) =>
                        setNewVacation((s) => ({ ...s, start: e.target.value }))
                      }
                      aria-label="Vacation start"
                    />
                    <Input
                      type="date"
                      value={newVacation.end}
                      onChange={(e) =>
                        setNewVacation((s) => ({ ...s, end: e.target.value }))
                      }
                      aria-label="Vacation end"
                    />
                    <Input
                      placeholder="Label (e.g. BC trip)"
                      value={newVacation.label}
                      onChange={(e) =>
                        setNewVacation((s) => ({ ...s, label: e.target.value }))
                      }
                      aria-label="Vacation label"
                    />
                    <Button
                      type="button"
                      onClick={addVacation}
                      disabled={
                        !newVacation.start ||
                        !newVacation.end ||
                        !newVacation.label.trim() ||
                        newVacation.end < newVacation.start
                      }
                    >
                      Add vacation
                    </Button>
                  </div>
                  {newVacation.start &&
                    newVacation.end &&
                    newVacation.end < newVacation.start && (
                      <p className="mt-1 text-xs text-destructive">
                        End date must be on or after the start date.
                      </p>
                    )}
                </div>

                <SectionFooter
                  dirty={isSectionDirty("holidays")}
                  saving={savingSection === "holidays"}
                  savedAt={savedAt["holidays"] ?? null}
                  error={sectionErrors["holidays"] ?? null}
                  onSave={() =>
                    saveSection(
                      "holidays",
                      SECTIONS.find((s) => s.id === "holidays")!.fields,
                    )
                  }
                />
              </section>
            )}

            {/* ── YNAB integration ── */}
            {visibleIds.has("ynab") && <YnabSection />}

            {/* ── Data storage (read-only) ── */}
            {visibleIds.has("data-storage") && (
              <section id="data-storage" className="scroll-mt-4">
                <h2 className="text-lg font-semibold text-foreground mb-1">
                  Data storage
                </h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Infrastructure details — these are managed and cannot be changed here.
                </p>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    <strong className="text-foreground">Database:</strong> Aurora
                    Serverless v2 (managed). Backups are taken automatically by AWS.
                  </p>
                  <p>
                    <strong className="text-foreground">Timesheet PDFs:</strong>{" "}
                    generated on demand — use the "Export PDF" button on the
                    Timesheets page.
                  </p>
                  <p>
                    <strong className="text-foreground">Invoice PDFs:</strong>{" "}
                    generated on demand — use the "Download PDF" button on the
                    Invoice edit page.
                  </p>
                </div>
              </section>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
