CREATE TABLE "personal_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"institution" varchar(30) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"currency" varchar(3) DEFAULT 'CAD' NOT NULL,
	"opening_balance" numeric(15, 2) DEFAULT '0',
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"institution" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"s3_key" text NOT NULL,
	"filename" text,
	"size_bytes" integer,
	"row_count" integer,
	"imported_count" integer,
	"skipped_count" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"import_id" uuid,
	"posted_date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(15, 2) NOT NULL,
	"balance" numeric(15, 2),
	"category" varchar(50),
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personal_imports" ADD CONSTRAINT "personal_imports_account_id_personal_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_transactions" ADD CONSTRAINT "personal_transactions_account_id_personal_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."personal_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_transactions" ADD CONSTRAINT "personal_transactions_import_id_personal_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."personal_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "personal_accounts_is_active_idx" ON "personal_accounts" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "personal_imports_account_idx" ON "personal_imports" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "personal_imports_status_idx" ON "personal_imports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "personal_transactions_account_idx" ON "personal_transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "personal_transactions_posted_date_idx" ON "personal_transactions" USING btree ("posted_date");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_transactions_dedup_idx" ON "personal_transactions" USING btree ("account_id","posted_date","amount","description");