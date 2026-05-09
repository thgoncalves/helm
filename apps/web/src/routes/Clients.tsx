/**
 * Clients page — lists all clients from GET /business/clients.
 *
 * Uses TanStack Query for data fetching with loading and error states.
 * Renders a simple table inside a Card using shadcn/ui primitives.
 */
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ClientRead } from "@/types/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SignOutButton } from "@/components/SignOutButton";

function formatRate(rate: number | string | null): string {
  if (rate === null || rate === undefined) return "—";
  // Pydantic v2 serialises Decimal as a JSON string; coerce to number.
  const num = typeof rate === "string" ? Number(rate) : rate;
  if (Number.isNaN(num)) return "—";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(num);
}

export function Clients() {
  const {
    data: clients,
    isLoading,
    isError,
    error,
  } = useQuery<ClientRead[]>({
    queryKey: ["clients"],
    queryFn: () => apiFetch<ClientRead[]>("/business/clients/"),
    staleTime: 60_000, // 1 minute
  });

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <h1 className="text-xl font-semibold">Helm</h1>
          <SignOutButton />
        </div>
      </header>

      {/* Main content */}
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Clients</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && (
              <p className="text-muted-foreground">Loading clients…</p>
            )}

            {isError && (
              <p className="text-destructive">
                Failed to load clients:{" "}
                {error instanceof Error ? error.message : "Unknown error"}
              </p>
            )}

            {clients && clients.length === 0 && (
              <p className="text-muted-foreground">No clients found.</p>
            )}

            {clients && clients.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Name
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Email
                      </th>
                      <th className="pb-3 pr-4 font-medium text-muted-foreground">
                        Hourly rate
                      </th>
                      <th className="pb-3 font-medium text-muted-foreground">
                        Status
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((client) => (
                      <tr key={client.id} className="border-b last:border-0">
                        <td className="py-3 pr-4 font-medium">{client.name}</td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {client.email ?? "—"}
                        </td>
                        <td className="py-3 pr-4">
                          {formatRate(client.hourly_rate)}
                        </td>
                        <td className="py-3">
                          <span
                            className={
                              client.is_active
                                ? "inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800"
                                : "inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600"
                            }
                          >
                            {client.is_active ? "Active" : "Inactive"}
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
