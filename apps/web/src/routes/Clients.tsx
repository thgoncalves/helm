/**
 * Clients page — lists clients from GET /business/clients.
 *
 * Features:
 * - "Show Archived" checkbox toggles include_archived query param.
 * - Client-side search filtering (name, email, city).
 * - Clickable rows navigate to /clients/:id.
 * - "New Client" button navigates to /clients/new.
 *
 * Uses TanStack Query for data fetching. Query key includes `includeArchived`
 * so the cache is keyed separately for each filter state.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { apiFetch } from "@/lib/api";
import type { ClientRead } from "@/types/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppHeader } from "@/components/AppHeader";
import { LoadingBox } from "@/components/LoadingScreen";

function formatRate(rate: number | string | null | undefined): string {
  if (rate === null || rate === undefined) return "—";
  const num = typeof rate === "string" ? Number(rate) : rate;
  if (Number.isNaN(num)) return "—";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(num);
}

export function Clients() {
  const navigate = useNavigate();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState("");

  const {
    data: clients,
    isLoading,
    isError,
    error,
  } = useQuery<ClientRead[]>({
    queryKey: ["clients", includeArchived],
    queryFn: () => {
      const qs = includeArchived ? "?include_archived=true" : "";
      return apiFetch<ClientRead[]>(`/business/clients/${qs}`);
    },
    staleTime: 60_000,
  });

  // Client-side search: case-insensitive match against name, email, city.
  const filtered = (clients ?? []).filter((c) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      (c.email ?? "").toLowerCase().includes(q) ||
      (c.city ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      {/* Main content */}
      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* Page title + New Client button */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-bold">Clients</h2>
          <Button onClick={() => navigate("/clients/new")}>
            New Client
          </Button>
        </div>

        {/* Show Archived checkbox */}
        <div className="mb-3 flex items-center gap-2">
          <input
            id="show-archived"
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-4 w-4 cursor-pointer rounded border-input"
          />
          <label
            htmlFor="show-archived"
            className="cursor-pointer select-none text-sm"
          >
            Show Archived
          </label>
        </div>

        {/* Search + Clear */}
        <div className="mb-4 flex gap-2">
          <Input
            placeholder="Search by name, email, or city…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
            aria-label="Search clients"
          />
          <Button
            variant="outline"
            onClick={() => setSearch("")}
            disabled={!search}
          >
            Clear
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Clients</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && (
              <LoadingBox />
            )}

            {isError && (
              <p className="text-destructive">
                Failed to load clients:{" "}
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            )}

            {!isLoading && !isError && filtered.length === 0 && (
              <p className="text-muted-foreground">No clients found.</p>
            )}

            {filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Email
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Phone
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        City
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Hourly Rate
                      </th>
                      <th className="pb-3 font-medium text-muted-foreground">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr
                        key={c.id}
                        className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                        onClick={() => navigate(`/clients/${c.id}`)}
                      >
                        <td className="whitespace-nowrap py-3 pr-4 font-medium">
                          {c.name}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">
                          {c.email ?? "—"}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">
                          {c.phone ?? "—"}
                        </td>
                        <td className="whitespace-nowrap py-3 pr-4 text-muted-foreground">
                          {c.city ?? "—"}
                        </td>
                        <td className="py-3 pr-4">
                          {formatRate(c.hourly_rate)}
                        </td>
                        <td className="py-3">
                          <span
                            className={
                              c.is_active
                                ? "inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300"
                                : "inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                            }
                          >
                            {c.is_active ? "Active" : "Archived"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
