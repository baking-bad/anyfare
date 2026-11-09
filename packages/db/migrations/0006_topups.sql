CREATE TABLE "topups" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"request_id" text,
	"status" text NOT NULL,
	"network" text NOT NULL,
	"blockchain" text NOT NULL,
	"token_symbol" text NOT NULL,
	"origin_asset" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"destination_asset" text NOT NULL,
	"recipient" text NOT NULL,
	"refund_to" text NOT NULL,
	"pay_by" timestamp (3) with time zone NOT NULL,
	"quote_request" jsonb NOT NULL,
	"quote_response" jsonb,
	"correlation_id" text,
	"deposit_address" text,
	"deposit_memo" text,
	"address_expires_at" timestamp (3) with time zone,
	"send_amount" numeric(78, 0),
	"send_at_least" numeric(78, 0),
	"estimated_credits" bigint,
	"quote_error" text,
	"oneclick_status" text,
	"last_status" jsonb,
	"deposited_amount" numeric(78, 0),
	"credited_amount" bigint,
	"ledger_transaction_id" text,
	"delivery_tx_hash" text,
	"refunded_amount" numeric(78, 0),
	"refund_reason" text,
	"refund_tx_hash" text,
	"origin_tx_hashes" jsonb NOT NULL,
	"needs_review" boolean NOT NULL,
	"review_reason" text,
	"next_poll_at" timestamp (3) with time zone,
	"last_polled_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "topups_status_check" CHECK ("topups"."status" in ('quoting', 'quote_failed', 'quote_unknown', 'waiting', 'incomplete', 'processing', 'credited', 'refunded', 'failed', 'expired')),
	CONSTRAINT "topups_deposit_address_check" CHECK (("topups"."status" in ('quoting', 'quote_failed', 'quote_unknown')) = ("topups"."deposit_address" is null)),
	CONSTRAINT "topups_amount_check" CHECK ("topups"."amount" > 0 and "topups"."token_decimals" >= 0 and "topups"."token_decimals" <= 36)
);
--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topups" ADD CONSTRAINT "topups_ledger_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topups_account_idx" ON "topups" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "topups_next_poll_idx" ON "topups" USING btree ("next_poll_at") WHERE next_poll_at is not null;--> statement-breakpoint
CREATE INDEX "topups_quoting_idx" ON "topups" USING btree ("created_at","id") WHERE status = 'quoting';--> statement-breakpoint
CREATE UNIQUE INDEX "topups_deposit_address_idx" ON "topups" USING btree ("deposit_address") WHERE deposit_address is not null;