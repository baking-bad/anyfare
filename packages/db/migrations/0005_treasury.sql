CREATE TABLE "reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp (3) with time zone NOT NULL,
	"results" json NOT NULL,
	"alerts" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treasury_transfers" (
	"reference" text PRIMARY KEY NOT NULL,
	"from_asset" text NOT NULL,
	"from_amount" bigint NOT NULL,
	"to_asset" text NOT NULL,
	"to_amount" bigint NOT NULL,
	"transactions" json NOT NULL,
	"recorded_by" text NOT NULL,
	"ledger_transaction_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "treasury_transfers_amounts_check" CHECK ("treasury_transfers"."from_amount" > 0 and "treasury_transfers"."to_amount" > 0 and "treasury_transfers"."to_amount" <= "treasury_transfers"."from_amount")
);
--> statement-breakpoint
ALTER TABLE "treasury_transfers" ADD CONSTRAINT "treasury_transfers_ledger_transaction_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_runs_ran_at_idx" ON "reconciliation_runs" USING btree ("ran_at");--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_transfers_ledger_transaction_idx" ON "treasury_transfers" USING btree ("ledger_transaction_id");