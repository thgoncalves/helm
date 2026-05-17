CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text,
	"tax_id" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"hourly_rate" numeric(10, 2),
	"timesheet_frequency" varchar(20) DEFAULT 'monthly',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_number" text NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date,
	"client_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"currency" varchar(3) DEFAULT 'CAD' NOT NULL,
	"subtotal" numeric(15, 2) NOT NULL,
	"tax_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"total" numeric(15, 2) NOT NULL,
	"notes" text,
	"payment_terms" text,
	"attachments_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number")
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_order" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(10, 2) NOT NULL,
	"unit_price" numeric(15, 2) NOT NULL,
	"tax_category" varchar(20),
	"is_taxable" boolean DEFAULT true NOT NULL,
	"tax_rate" numeric(6, 4),
	"line_subtotal" numeric(15, 2) NOT NULL,
	"line_tax" numeric(15, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(15, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments_received" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"payment_method" text,
	"reference" text,
	"notes" text,
	"deduction_amount" numeric(15, 2) DEFAULT '0' NOT NULL,
	"deduction_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"hours" numeric(5, 2) NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_type" varchar(20) NOT NULL,
	"tax_period" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"tax_rate" numeric(6, 4) NOT NULL,
	"taxable_amount" numeric(15, 2) NOT NULL,
	"tax_amount" numeric(15, 2) NOT NULL,
	"paid_status" varchar(20) DEFAULT 'unpaid' NOT NULL,
	"paid_date" date,
	"paid_amount" numeric(15, 2) DEFAULT '0',
	"payment_method" text,
	"payment_reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_id" uuid,
	"payment_date" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"payment_method" text,
	"payment_reference" text,
	"fiscal_year" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_tax_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"tax_payment_id" uuid NOT NULL,
	"tax_id" uuid,
	"gst_amount" numeric(15, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_date" date NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"method" varchar(50),
	"purpose" text,
	"category" varchar(50),
	"estimated_tax_company" numeric(15, 2),
	"estimated_tax_personal" numeric(15, 2),
	"actual_tax_paid_company" numeric(15, 2),
	"actual_tax_paid_personal" numeric(15, 2),
	"tax_ledger_link_company" uuid,
	"tax_ledger_link_personal" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments_received" ADD CONSTRAINT "payments_received_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_tax_id_tax_ledger_id_fk" FOREIGN KEY ("tax_id") REFERENCES "public"."tax_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_tax_links" ADD CONSTRAINT "invoice_tax_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_tax_links" ADD CONSTRAINT "invoice_tax_links_tax_payment_id_tax_payments_id_fk" FOREIGN KEY ("tax_payment_id") REFERENCES "public"."tax_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_tax_links" ADD CONSTRAINT "invoice_tax_links_tax_id_tax_ledger_id_fk" FOREIGN KEY ("tax_id") REFERENCES "public"."tax_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_tax_ledger_link_company_tax_ledger_id_fk" FOREIGN KEY ("tax_ledger_link_company") REFERENCES "public"."tax_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_tax_ledger_link_personal_tax_ledger_id_fk" FOREIGN KEY ("tax_ledger_link_personal") REFERENCES "public"."tax_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_is_active_idx" ON "clients" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "invoices_client_idx" ON "invoices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_issue_date_idx" ON "invoices" USING btree ("issue_date");--> statement-breakpoint
CREATE INDEX "invoice_line_items_invoice_idx" ON "invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_received_invoice_idx" ON "payments_received" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_received_payment_date_idx" ON "payments_received" USING btree ("payment_date");--> statement-breakpoint
CREATE INDEX "time_entries_client_idx" ON "time_entries" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "time_entries_work_date_idx" ON "time_entries" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX "time_entries_invoice_idx" ON "time_entries" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "tax_payments_tax_idx" ON "tax_payments" USING btree ("tax_id");--> statement-breakpoint
CREATE INDEX "tax_payments_payment_date_idx" ON "tax_payments" USING btree ("payment_date");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_tax_links_unique" ON "invoice_tax_links" USING btree ("invoice_id","tax_payment_id");--> statement-breakpoint
CREATE INDEX "invoice_tax_links_tax_payment_idx" ON "invoice_tax_links" USING btree ("tax_payment_id");--> statement-breakpoint
CREATE INDEX "transfers_transfer_date_idx" ON "transfers" USING btree ("transfer_date");