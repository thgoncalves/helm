/**
 * PersonalImports — upload a CSV bank statement, see history.
 *
 * Flow:
 *  1. Pick an account + an institution preset.
 *  2. Pick a CSV file → POST /personal/imports/ → presigned PUT.
 *  3. Upload to S3.
 *  4. The S3-triggered processor parses + inserts transactions.
 *  5. The table on this page polls every 3 s while any row is still
 *     pending or processing.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch, ApiError } from "@/lib/api";
import type {
  Institution,
  PersonalAccountRead,
  PersonalImportCreateResponse,
  PersonalImportRead,
  PersonalImportStatus,
} from "@/types/api";
import { AppHeader } from "@/components/AppHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const SELECT_CLASSES =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2";

const INSTITUTIONS: Institution[] = ["RBC", "TD", "Scotia", "Other"];

const STATUS_STYLES: Record<PersonalImportStatus, string> = {
  pending: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  processing:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  ready:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
};

function StatusBadge({ status }: { status: PersonalImportStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {status[0]!.toUpperCase() + status.slice(1)}
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function PersonalImports() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [institution, setInstitution] = useState<Institution>("RBC");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const accountsQuery = useQuery<PersonalAccountRead[]>({
    queryKey: ["personal-accounts", false],
    queryFn: () => apiFetch<PersonalAccountRead[]>("/personal/accounts/"),
  });

  // Auto-pick the first account once they load.
  useMemo(() => {
    if (
      !accountId &&
      accountsQuery.data &&
      accountsQuery.data.length > 0
    ) {
      const first = accountsQuery.data[0];
      if (first) {
        setAccountId(first.id);
        setInstitution(first.institution);
      }
    }
  }, [accountId, accountsQuery.data]);

  const importsQuery = useQuery<PersonalImportRead[]>({
    queryKey: ["personal-imports"],
    queryFn: () => apiFetch<PersonalImportRead[]>("/personal/imports/"),
    refetchInterval: (query) => {
      const rows = (query.state.data ?? []) as PersonalImportRead[];
      return rows.some(
        (r) => r.status === "pending" || r.status === "processing",
      )
        ? 3000
        : false;
    },
  });

  const uploadMutation = useMutation<
    PersonalImportRead,
    ApiError | Error,
    File
  >({
    mutationFn: async (file) => {
      if (!accountId) throw new Error("Pick an account first");
      const created = await apiFetch<PersonalImportCreateResponse>(
        "/personal/imports/",
        {
          method: "POST",
          body: JSON.stringify({
            account_id: accountId,
            institution,
            filename: file.name,
            size_bytes: file.size,
          }),
        },
      );
      const uploadHost = new URL(created.upload_url).host;
      let putResponse: Response;
      try {
        putResponse = await fetch(created.upload_url, {
          method: "PUT",
          body: file,
        });
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        // Surface the host so we can tell at a glance whether the URL was
        // regional (helm-receipts-<env>.s3.<region>...) or not.
        throw new Error(
          `Network error PUTting to ${uploadHost}: ${msg}. ` +
            `File: ${file.name} (${file.size}B, ${file.type || "no type"}).`,
        );
      }
      if (!putResponse.ok) {
        const errBody = await putResponse.text().catch(() => "");
        throw new Error(
          `S3 upload failed (${putResponse.status} from ${uploadHost}): ${errBody.slice(0, 200)}`,
        );
      }
      return created.import_;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["personal-imports"],
      });
    },
    onError: (err) => {
      setUploadError(
        err instanceof ApiError
          ? typeof err.body === "object" && err.body && "detail" in err.body
            ? String((err.body as { detail: unknown }).detail)
            : `Server error ${err.status}`
          : err instanceof Error
            ? err.message
            : "Unknown error",
      );
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    if (!accountId) {
      setUploadError("Pick an account first.");
      return;
    }
    uploadMutation.mutate(file);
  }

  const accounts = accountsQuery.data ?? [];
  const accountNameById = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <div className="mb-6 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <h2 className="text-2xl font-bold">Imports</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => navigate("/personal/accounts")}
            >
              Accounts
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate("/personal/transactions")}
            >
              Transactions
            </Button>
          </div>
        </div>

        <Card className="mb-6">
          <CardContent className="grid grid-cols-1 gap-4 pt-6 sm:grid-cols-[160px_1fr] sm:items-center">
            <label htmlFor="account">Account</label>
            <select
              id="account"
              className={SELECT_CLASSES}
              value={accountId}
              onChange={(e) => {
                setAccountId(e.target.value);
                const picked = accounts.find((a) => a.id === e.target.value);
                if (picked) setInstitution(picked.institution);
              }}
            >
              <option value="">Select an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {a.institution}
                </option>
              ))}
            </select>

            <label htmlFor="institution">Parser</label>
            <select
              id="institution"
              className={SELECT_CLASSES}
              value={institution}
              onChange={(e) => setInstitution(e.target.value as Institution)}
            >
              {INSTITUTIONS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>

            <span></span>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!accountId || uploadMutation.isPending}
              >
                {uploadMutation.isPending ? "Uploading…" : "Upload CSV"}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv,application/vnd.ms-excel"
                onChange={handleFileChange}
                className="hidden"
                aria-label="CSV file"
              />
              {!accountId && (
                <p className="text-sm text-muted-foreground">
                  Pick an account first.
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {uploadError && (
          <p className="mb-3 text-sm text-destructive">
            Upload failed: {uploadError}
          </p>
        )}

        <Card>
          <CardContent className="p-0">
            {importsQuery.isLoading && (
              <p className="p-6 text-muted-foreground">Loading imports…</p>
            )}
            {(importsQuery.data ?? []).length === 0 && !importsQuery.isLoading && (
              <p className="p-6 text-muted-foreground">No imports yet.</p>
            )}
            {(importsQuery.data ?? []).length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40 text-left">
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">When</th>
                      <th className="px-4 py-2 font-semibold">Account</th>
                      <th className="px-4 py-2 font-semibold">Parser</th>
                      <th className="px-4 py-2 font-semibold">Filename</th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Imported
                      </th>
                      <th className="px-4 py-2 text-right font-semibold">
                        Skipped
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(importsQuery.data ?? []).map((imp) => (
                      <tr key={imp.id} className="border-b last:border-0">
                        <td className="px-4 py-2">
                          <StatusBadge status={imp.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                          {formatDate(imp.created_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          {accountNameById.get(imp.account_id) ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2">{imp.institution}</td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {imp.filename ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right">
                          {imp.imported_count ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground">
                          {imp.skipped_count ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Errors live under the table — collapsed into a card so failed
            imports don't blow out the layout. */}
        {(importsQuery.data ?? []).some((i) => i.status === "failed") && (
          <Card className="mt-4">
            <CardContent className="space-y-2 pt-6 text-sm">
              <h3 className="font-semibold">Failed imports</h3>
              {(importsQuery.data ?? [])
                .filter((i) => i.status === "failed")
                .map((i) => (
                  <p key={i.id} className="text-destructive">
                    <span className="font-medium">
                      {i.filename ?? i.id}
                    </span>{" "}
                    — {i.error ?? "Unknown error"}
                  </p>
                ))}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
