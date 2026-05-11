ALTER TABLE "clients" ADD COLUMN "default_taxable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "default_tax_rate" numeric(6, 4);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "default_payment_terms_days" integer DEFAULT 30 NOT NULL;