/**
 * ClientDetail — read-only detail view for a single client.
 *
 * Route: /clients/:id
 *
 * Shows all client fields grouped by section. Provides "Back" (→ /clients)
 * and "Edit" (→ /clients/:id/edit) actions in the header.
 */
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import type { ClientRead } from "@/types/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/AppHeader";
import { ApiError } from "@/lib/api";
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

function Field({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="py-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm">{value ?? "—"}</dd>
    </div>
  );
}

export function ClientDetail() {
  const { id } = useParams<{ id: string }>();

  const { data: client, isLoading, isError, error } = useQuery<ClientRead>({
    queryKey: ["client", id],
    queryFn: () => apiFetch<ClientRead>(`/business/clients/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => {
      // Don't retry on 404.
      if (err instanceof ApiError && err.status === 404) return false;
      return count < 2;
    },
  });

  const is404 =
    isError && error instanceof ApiError && error.status === 404;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* Page header */}
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-2xl font-bold">
            {client ? client.name : "Client"}
          </h2>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <Link to="/clients">Back</Link>
            </Button>
            {client && (
              <Button asChild>
                <Link to={`/clients/${id}/edit`}>Edit</Link>
              </Button>
            )}
          </div>
        </div>

        {isLoading && (
          <LoadingBox />
        )}

        {is404 && (
          <div className="text-center py-12">
            <p className="text-lg font-medium">Client not found.</p>
            <p className="mt-2 text-muted-foreground">
              The client you're looking for doesn't exist.
            </p>
            <Button variant="outline" className="mt-4" asChild>
              <Link to="/clients">Back to Clients</Link>
            </Button>
          </div>
        )}

        {isError && !is404 && (
          <p className="text-destructive">
            Failed to load client:{" "}
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
        )}

        {client && (
          <div className="space-y-6">
            {/* Contact info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Contact</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                  <Field label="Name" value={client.name} />
                  <Field label="Email" value={client.email} />
                  <Field label="Phone" value={client.phone} />
                  <Field label="Tax ID" value={client.tax_id} />
                </dl>
              </CardContent>
            </Card>

            {/* Address */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Address</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                  <Field label="Address Line 1" value={client.address_line1} />
                  <Field label="Address Line 2" value={client.address_line2} />
                  <Field label="City" value={client.city} />
                  <Field label="State / Province" value={client.state} />
                  <Field label="Postal Code" value={client.postal_code} />
                  <Field label="Country" value={client.country} />
                </dl>
              </CardContent>
            </Card>

            {/* Billing */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Billing</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                  <Field label="Hourly Rate" value={formatRate(client.hourly_rate)} />
                  <Field
                    label="Timesheet Frequency"
                    value={client.timesheet_frequency ?? "—"}
                  />
                  <div className="py-2">
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Status
                    </dt>
                    <dd className="mt-0.5">
                      <span
                        className={
                          client.is_active
                            ? "inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300"
                            : "inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                        }
                      >
                        {client.is_active ? "Active" : "Archived"}
                      </span>
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            {/* Notes */}
            {client.notes && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Notes</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap text-sm">{client.notes}</p>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
