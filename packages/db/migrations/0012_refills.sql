CREATE TABLE "refills" (
	"id" text PRIMARY KEY NOT NULL,
	"asset" text NOT NULL,
	"source_asset" text NOT NULL,
	"amount" bigint NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"deposit_address" text,
	"amount_in" numeric(78, 0),
	"amount_out" numeric(78, 0),
	"amount_in_usd" bigint,
	"amount_out_usd" bigint,
	"quote_deadline" timestamp (3) with time zone,
	"correlation_id" text,
	"near_transaction_hash" text,
	"delivery_transaction_hashes" text[] NOT NULL,
	"quote" jsonb,
	"last_status" jsonb,
	"refunded_amount" numeric(78, 0),
	"refund_fee" numeric(78, 0),
	"refund_reason" text,
	"next_poll_at" timestamp (3) with time zone,
	"polls" integer NOT NULL,
	"ledger_transaction_id" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	CONSTRAINT "refills_status_check" CHECK ("refills"."status" in ('requested', 'sent', 'unknown', 'succeeded', 'refunded', 'failed', 'not_sent', 'review')),
	CONSTRAINT "refills_amount_check" CHECK ("refills"."amount" > 0 and "refills"."polls" >= 0),
	CONSTRAINT "refills_deposit_address_check" CHECK ("refills"."status" not in ('sent', 'unknown', 'succeeded', 'refunded') or "refills"."deposit_address" is not null),
	CONSTRAINT "refills_booked_check" CHECK ("refills"."status" <> 'succeeded' or "refills"."ledger_transaction_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "refills" ADD CONSTRAINT "refills_ledger_transaction_fk" FOREIGN KEY ("ledger_transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refills_in_flight_idx" ON "refills" USING btree ("asset") WHERE status in ('requested', 'sent', 'unknown', 'review');--> statement-breakpoint
CREATE UNIQUE INDEX "refills_deposit_address_idx" ON "refills" USING btree ("deposit_address") WHERE deposit_address is not null;--> statement-breakpoint
CREATE INDEX "refills_next_poll_idx" ON "refills" USING btree ("next_poll_at") WHERE next_poll_at is not null;