/**
 * ClientForm — shared form component for creating and editing clients.
 *
 * Exported route components:
 *   NewClient  — wraps ClientForm with mode="create" at /clients/new.
 *   EditClient — wraps ClientForm with mode="edit" at /clients/:id/edit.
 *                Fetches existing client data before rendering the form.
 *
 * Validation: React Hook Form + Zod (name is required; all other fields optional).
 * Mutations: TanStack Query useMutation; invalidates ['clients'] and ['client', id] on success.
 *
 * Design decisions:
 * - Used option (a) from the spec: ClientCreate already has is_active; PUT passes it through.
 * - Active/Archived toggle (checkbox) is rendered only in edit mode.
 * - Notes uses a styled <textarea> matching the Input Tailwind classes.
 * - "New Client" always defaults is_active=true (field hidden).
 * - Hourly Rate allows blank entry → sends null to the API.
 */
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/api";
import type { ClientRead, ClientCreate } from "@/types/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppHeader } from "@/components/AppHeader";
import { LoadingBox } from "@/components/LoadingScreen";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const clientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email").or(z.literal("")).nullable().optional(),
  phone: z.string().nullable().optional(),
  address_line1: z.string().nullable().optional(),
  address_line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  tax_id: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  hourly_rate: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : v;
    }),
  timesheet_frequency: z.string().nullable().optional(),
  contract_value: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : v;
    }),
  contract_currency: z.string().nullable().optional(),
  contract_start_date: z.string().nullable().optional(),
  contract_end_date: z.string().nullable().optional(),
  default_task_description: z.string().nullable().optional(),
  default_taxable: z.boolean().optional(),
  default_tax_rate: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v === "" || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : v;
    }),
  default_payment_terms_days: z.string().optional(),
  is_active: z.boolean().optional(),
});

type ClientFormValues = z.infer<typeof clientSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toFormValues(client: ClientRead): ClientFormValues {
  return {
    name: client.name,
    email: client.email ?? "",
    phone: client.phone ?? "",
    address_line1: client.address_line1 ?? "",
    address_line2: client.address_line2 ?? "",
    city: client.city ?? "",
    state: client.state ?? "",
    postal_code: client.postal_code ?? "",
    country: client.country ?? "",
    tax_id: client.tax_id ?? "",
    notes: client.notes ?? "",
    hourly_rate:
      client.hourly_rate !== null && client.hourly_rate !== undefined
        ? String(client.hourly_rate)
        : "",
    timesheet_frequency: client.timesheet_frequency ?? "monthly",
    contract_value:
      client.contract_value !== null && client.contract_value !== undefined
        ? String(client.contract_value)
        : "",
    contract_currency: client.contract_currency ?? "CAD",
    contract_start_date: client.contract_start_date ?? "",
    contract_end_date: client.contract_end_date ?? "",
    default_task_description: client.default_task_description ?? "",
    default_taxable: client.default_taxable,
    default_tax_rate:
      client.default_tax_rate !== null && client.default_tax_rate !== undefined
        ? String(client.default_tax_rate)
        : "",
    default_payment_terms_days: String(client.default_payment_terms_days ?? 30),
    is_active: client.is_active,
  };
}

function toApiPayload(values: ClientFormValues): ClientCreate {
  return {
    name: values.name,
    email: values.email || null,
    phone: values.phone || null,
    address_line1: values.address_line1 || null,
    address_line2: values.address_line2 || null,
    city: values.city || null,
    state: values.state || null,
    postal_code: values.postal_code || null,
    country: values.country || null,
    tax_id: values.tax_id || null,
    notes: values.notes || null,
    hourly_rate: values.hourly_rate ?? null,
    timesheet_frequency: values.timesheet_frequency ?? "monthly",
    contract_value: values.contract_value ?? null,
    contract_currency: values.contract_currency || "CAD",
    contract_start_date: values.contract_start_date || null,
    contract_end_date: values.contract_end_date || null,
    default_task_description: values.default_task_description || null,
    default_taxable: values.default_taxable ?? true,
    default_tax_rate: values.default_tax_rate ?? null,
    default_payment_terms_days: (() => {
      const v = values.default_payment_terms_days;
      if (v === "" || v === null || v === undefined) return 30;
      const n = Number(v);
      return Number.isNaN(n) ? 30 : n;
    })(),
    is_active: values.is_active ?? true,
  };
}

// ---------------------------------------------------------------------------
// Shared textarea classes to match <Input>
// ---------------------------------------------------------------------------

const textareaClasses =
  "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// ClientForm inner component
// ---------------------------------------------------------------------------

interface ClientFormProps {
  mode: "create" | "edit";
  defaultValues: ClientFormValues;
  clientId?: string;
}

function ClientFormInner({ mode, defaultValues, clientId }: ClientFormProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ClientFormValues>({
    resolver: zodResolver(clientSchema),
    defaultValues,
  });

  // Re-populate form when edit defaults arrive (async fetch case).
  useEffect(() => {
    reset(defaultValues);
  }, [defaultValues, reset]);

  const mutation = useMutation<ClientRead, ApiError, ClientFormValues>({
    mutationFn: async (values) => {
      const payload = toApiPayload(values);
      if (mode === "create") {
        return apiFetch<ClientRead>("/business/clients/", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } else {
        return apiFetch<ClientRead>(`/business/clients/${clientId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["clients"] });
      if (clientId) {
        void queryClient.invalidateQueries({ queryKey: ["client", clientId] });
      }
      navigate(`/clients/${created.id}`);
    },
  });

  const serverError =
    mutation.error instanceof ApiError
      ? `Server error ${mutation.error.status}`
      : mutation.error
        ? String(mutation.error)
        : null;

  return (
    <form onSubmit={handleSubmit((v) => mutation.mutate(v))} noValidate>
      <div className="space-y-6">
        {/* Contact */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Name */}
            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="name"
                {...register("name")}
                aria-invalid={Boolean(errors.name)}
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>

            {/* Email */}
            <div className="space-y-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...register("email")} />
              {errors.email && (
                <p className="text-xs text-destructive">
                  {errors.email.message}
                </p>
              )}
            </div>

            {/* Phone */}
            <div className="space-y-1">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" type="tel" {...register("phone")} />
            </div>

            {/* Tax ID */}
            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="tax_id">Tax ID</Label>
              <Input
                id="tax_id"
                {...register("tax_id")}
                placeholder="Business number / GST number / ABN"
              />
            </div>
          </CardContent>
        </Card>

        {/* Address */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Address</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="address_line1">Address Line 1</Label>
              <Input id="address_line1" {...register("address_line1")} />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="address_line2">Address Line 2</Label>
              <Input id="address_line2" {...register("address_line2")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="city">City</Label>
              <Input id="city" {...register("city")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="state">State / Province</Label>
              <Input id="state" {...register("state")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="postal_code">Postal Code</Label>
              <Input id="postal_code" {...register("postal_code")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="country">Country</Label>
              <Input id="country" {...register("country")} />
            </div>
          </CardContent>
        </Card>

        {/* Notes */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                rows={4}
                className={textareaClasses}
                placeholder="Free-form notes about this client…"
                {...register("notes")}
              />
            </div>
          </CardContent>
        </Card>

        {/* Timesheet Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timesheet Settings</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Hourly Rate */}
            <div className="space-y-1">
              <Label htmlFor="hourly_rate">Hourly Rate</Label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="hourly_rate"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Not set"
                  className="pl-6"
                  {...register("hourly_rate")}
                />
              </div>
            </div>

            {/* Timesheet Frequency */}
            <div className="space-y-1">
              <Label htmlFor="timesheet_frequency">Timesheet Frequency</Label>
              <select
                id="timesheet_frequency"
                className={
                  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
                  "ring-offset-background focus-visible:outline-none focus-visible:ring-2 " +
                  "focus-visible:ring-ring focus-visible:ring-offset-2"
                }
                {...register("timesheet_frequency")}
              >
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
            </div>
          </CardContent>
        </Card>

        {/* Contract */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contract</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="contract_value">Contract Value</Label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="contract_value"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Not set"
                  className="pl-6"
                  {...register("contract_value")}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="contract_currency">Currency</Label>
              <Input
                id="contract_currency"
                maxLength={3}
                placeholder="CAD"
                {...register("contract_currency")}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="contract_start_date">Contract start</Label>
              <Input
                id="contract_start_date"
                type="date"
                {...register("contract_start_date")}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="contract_end_date">Contract end</Label>
              <Input
                id="contract_end_date"
                type="date"
                {...register("contract_end_date")}
              />
              <p className="text-xs text-muted-foreground">
                When set, the Timesheets page shows required pace (h/day).
              </p>
            </div>

            <div className="sm:col-span-2 space-y-1">
              <Label htmlFor="default_task_description">
                Default Task Description (PDF)
              </Label>
              <Input
                id="default_task_description"
                placeholder="e.g. Consulting services in ETL, ML and AI"
                {...register("default_task_description")}
              />
              <p className="text-xs text-muted-foreground">
                Printed on every populated row of the exported timesheet PDF.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Invoicing defaults */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invoicing Defaults</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex items-center gap-2">
              <input
                id="default_taxable"
                type="checkbox"
                className="h-4 w-4 cursor-pointer rounded border-input"
                {...register("default_taxable")}
              />
              <Label htmlFor="default_taxable" className="cursor-pointer">
                Apply GST by default
              </Label>
            </div>

            <div className="space-y-1">
              <Label htmlFor="default_tax_rate">Default Tax Rate</Label>
              <Input
                id="default_tax_rate"
                type="number"
                step="0.0001"
                min="0"
                max="1"
                placeholder="0.05 = 5%"
                {...register("default_tax_rate")}
              />
              <p className="text-xs text-muted-foreground">
                Decimal value (0.05 for 5% GST).
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="default_payment_terms_days">
                Payment Terms (days)
              </Label>
              <Input
                id="default_payment_terms_days"
                type="number"
                step="1"
                min="0"
                placeholder="30"
                {...register("default_payment_terms_days")}
              />
              <p className="text-xs text-muted-foreground">
                Net-N days: due date = issue date + N days.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Active/Archived toggle — edit mode only */}
        {mode === "edit" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <input
                  id="is_active"
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer rounded border-input"
                  {...register("is_active")}
                />
                <Label htmlFor="is_active" className="cursor-pointer">
                  Active (uncheck to archive)
                </Label>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Server error */}
        {serverError && (
          <p className="text-sm text-destructive">{serverError}</p>
        )}

        {/* Form actions */}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" asChild>
            <Link to={mode === "edit" && clientId ? `/clients/${clientId}` : "/clients"}>
              Cancel
            </Link>
          </Button>
          <Button type="submit" disabled={isSubmitting || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// NewClient route component
// ---------------------------------------------------------------------------

const newClientDefaults: ClientFormValues = {
  name: "",
  email: "",
  phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postal_code: "",
  country: "Canada",
  tax_id: "",
  notes: "",
  hourly_rate: "",
  timesheet_frequency: "monthly",
  contract_value: "",
  contract_currency: "CAD",
  contract_start_date: "",
  contract_end_date: "",
  default_task_description: "",
  default_taxable: true,
  default_tax_rate: "0.05",
  default_payment_terms_days: "30",
  is_active: true,
};

export function NewClient() {
  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">New Client</h2>
        </div>
        <ClientFormInner mode="create" defaultValues={newClientDefaults} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EditClient route component
// ---------------------------------------------------------------------------

export function EditClient() {
  const { id } = useParams<{ id: string }>();

  const { data: client, isLoading, isError, error } = useQuery<ClientRead>({
    queryKey: ["client", id],
    queryFn: () => apiFetch<ClientRead>(`/business/clients/${id}`),
    enabled: Boolean(id),
    retry: (count, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return count < 2;
    },
  });

  const is404 =
    isError && error instanceof ApiError && error.status === 404;

  return (
    <div className="min-h-screen bg-background">
      <AppHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6">
          <h2 className="text-2xl font-bold">
            {client ? `Edit ${client.name}` : "Edit Client"}
          </h2>
        </div>

        {isLoading && <LoadingBox />}

        {is404 && (
          <div className="text-center py-12">
            <p className="text-lg font-medium">Client not found.</p>
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
          <ClientFormInner
            mode="edit"
            defaultValues={toFormValues(client)}
            clientId={id}
          />
        )}
      </main>
    </div>
  );
}
