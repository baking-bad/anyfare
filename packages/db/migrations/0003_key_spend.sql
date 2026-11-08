CREATE TABLE "key_daily_spend" (
	"key_id" text NOT NULL,
	"day" date NOT NULL,
	"spent" bigint NOT NULL,
	CONSTRAINT "key_daily_spend_pkey" PRIMARY KEY("key_id","day"),
	CONSTRAINT "key_daily_spend_spent_check" CHECK ("key_daily_spend"."spent" >= 0)
);
--> statement-breakpoint
CREATE TABLE "key_total_spend" (
	"key_id" text PRIMARY KEY NOT NULL,
	"spent" bigint NOT NULL,
	CONSTRAINT "key_total_spend_spent_check" CHECK ("key_total_spend"."spent" >= 0)
);
--> statement-breakpoint
ALTER TABLE "key_daily_spend" ADD CONSTRAINT "key_daily_spend_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_total_spend" ADD CONSTRAINT "key_total_spend_key_id_api_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;