CREATE TABLE "treasury_fundings" (
	"reference" text PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"amount" bigint NOT NULL,
	"transactions" json NOT NULL,
	"note" text,
	"recorded_by" text NOT NULL,
	"ledger_transaction_id" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "treasury_fundings_amount_check" CHECK ("treasury_fundings"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "treasury_fundings" ADD CONSTRAINT "treasury_fundings_ledger_transaction_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "treasury_fundings_ledger_transaction_idx" ON "treasury_fundings" USING btree ("ledger_transaction_id");