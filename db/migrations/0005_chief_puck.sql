CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"s3_key" text NOT NULL,
	"content_type" varchar(60),
	"size_bytes" integer,
	"expense_date" date,
	"supplier" text,
	"category" varchar(50),
	"subtotal" numeric(15, 2),
	"tax_amount" numeric(15, 2),
	"total" numeric(15, 2),
	"currency" varchar(3) DEFAULT 'CAD',
	"notes" text,
	"ocr_raw" jsonb,
	"ocr_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "expenses_status_idx" ON "expenses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "expenses_expense_date_idx" ON "expenses" USING btree ("expense_date");