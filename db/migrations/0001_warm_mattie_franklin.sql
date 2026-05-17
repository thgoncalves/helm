ALTER TABLE "clients" ADD COLUMN "contract_value" numeric(15, 2);--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "contract_currency" varchar(3) DEFAULT 'CAD';--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "default_task_description" text;