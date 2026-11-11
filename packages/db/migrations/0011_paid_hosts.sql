CREATE TABLE "paid_hosts" (
	"host" text PRIMARY KEY NOT NULL,
	"registered_at" timestamp (3) with time zone NOT NULL,
	"listed_at" timestamp (3) with time zone NOT NULL,
	"paid_endpoints" integer NOT NULL,
	"endpoints" integer NOT NULL,
	"price_from" bigint,
	CONSTRAINT "paid_hosts_host_check" CHECK (octet_length("paid_hosts"."host") <= 259)
);
--> statement-breakpoint
CREATE INDEX "paid_hosts_registered_idx" ON "paid_hosts" USING btree ("registered_at","host");--> statement-breakpoint
CREATE INDEX "routed_endpoints_catalog_idx" ON "routed_endpoints" USING btree ("created_at","host","path");--> statement-breakpoint
DROP INDEX "routed_endpoints_created_idx";