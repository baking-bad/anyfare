CREATE TABLE "checked_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"parent" text NOT NULL,
	"listed_at" timestamp (3) with time zone NOT NULL,
	"checked_at" timestamp (3) with time zone NOT NULL,
	"paid_at" timestamp (3) with time zone,
	"checked_endpoints" integer NOT NULL,
	"price_from" bigint,
	CONSTRAINT "checked_hosts_host_check" CHECK (octet_length("checked_hosts"."host") <= 259),
	CONSTRAINT "checked_hosts_endpoints_check" CHECK ("checked_hosts"."checked_endpoints" >= 0)
);
--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD COLUMN "status" text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD COLUMN "checked_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD COLUMN "check_method" text;--> statement-breakpoint
ALTER TABLE "stats_services" ADD COLUMN "listed_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "checked_hosts_checked_idx" ON "checked_hosts" USING btree ("checked_at","host");--> statement-breakpoint
CREATE INDEX "checked_hosts_parent_idx" ON "checked_hosts" USING btree ("parent","checked_at");--> statement-breakpoint
CREATE INDEX "routed_endpoints_checked_idx" ON "routed_endpoints" USING btree ("host") WHERE status = 'checked';--> statement-breakpoint
CREATE INDEX "routed_endpoints_listed_idx" ON "routed_endpoints" USING btree ("host","created_at") WHERE status = 'paid';--> statement-breakpoint
CREATE INDEX "routed_endpoints_checked_order_idx" ON "routed_endpoints" USING btree ("checked_at") WHERE status = 'checked';--> statement-breakpoint
CREATE INDEX "routed_endpoints_fee_idx" ON "routed_endpoints" USING btree ("host") WHERE fee_bps is not null;--> statement-breakpoint
CREATE INDEX "routed_endpoints_created_idx" ON "routed_endpoints" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD CONSTRAINT "routed_endpoints_key_check" CHECK (octet_length("routed_endpoints"."host") <= 259 and octet_length("routed_endpoints"."path") <= 2048);--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD CONSTRAINT "routed_endpoints_status_check" CHECK ("routed_endpoints"."status" in ('paid', 'checked'));--> statement-breakpoint
ALTER TABLE "routed_endpoints" ADD CONSTRAINT "routed_endpoints_method_check" CHECK ("routed_endpoints"."check_method" is null or "routed_endpoints"."check_method" in ('GET', 'POST'));