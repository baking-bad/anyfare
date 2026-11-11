CREATE TABLE "call_details" (
	"payment_id" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"payer" text,
	"arrived_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_details" ADD CONSTRAINT "call_details_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_calls_idx" ON "payments" USING btree ("created_at","id") WHERE status in ('captured', 'settled', 'settling', 'released', 'cancelled', 'failed');--> statement-breakpoint
CREATE INDEX "payments_calls_paid_with_idx" ON "payments" USING btree (("rail" || coalesce(' ' || "network", '')),"created_at","id") WHERE status in ('captured', 'settled', 'settling', 'released', 'cancelled', 'failed');--> statement-breakpoint
CREATE INDEX "payments_calls_host_idx" ON "payments" USING btree (md5("target_host"),"created_at","id") WHERE status in ('captured', 'settled', 'settling', 'released', 'cancelled', 'failed');--> statement-breakpoint
CREATE INDEX "payments_calls_path_idx" ON "payments" USING btree (md5("target_path"),"created_at","id") WHERE status in ('captured', 'settled', 'settling', 'released', 'cancelled', 'failed');--> statement-breakpoint
CREATE INDEX "payments_calls_final_idx" ON "payments" USING btree ("updated_at","id") WHERE status in ('captured', 'settled', 'released', 'cancelled', 'failed');