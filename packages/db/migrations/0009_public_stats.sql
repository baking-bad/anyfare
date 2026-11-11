CREATE TABLE "stats_answers" (
	"key" text PRIMARY KEY NOT NULL,
	"answer" jsonb NOT NULL,
	"counted_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_buyers" (
	"day" date NOT NULL,
	"buyer_hash" text NOT NULL,
	CONSTRAINT "stats_buyers_pkey" PRIMARY KEY("day","buyer_hash")
);
--> statement-breakpoint
CREATE TABLE "stats_endpoints" (
	"host_hash" text NOT NULL,
	"path_hash" text NOT NULL,
	"path" text NOT NULL,
	"method" text,
	"price" bigint,
	"recent" jsonb NOT NULL,
	"daily" jsonb NOT NULL,
	"counted_at" timestamp (3) with time zone NOT NULL,
	"all" jsonb,
	"all_counted_at" timestamp (3) with time zone,
	CONSTRAINT "stats_endpoints_pkey" PRIMARY KEY("host_hash","path_hash"),
	CONSTRAINT "stats_endpoints_path_check" CHECK (length("stats_endpoints"."path") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "stats_service_pages" (
	"host_hash" text NOT NULL,
	"period" text NOT NULL,
	"answer" jsonb NOT NULL,
	"counted_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "stats_service_pages_pkey" PRIMARY KEY("host_hash","period"),
	CONSTRAINT "stats_service_pages_period_check" CHECK ("stats_service_pages"."period" in ('today', '7d', '30d', 'all'))
);
--> statement-breakpoint
CREATE TABLE "stats_services" (
	"host_hash" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"paid_endpoints" integer NOT NULL,
	"price_from" bigint,
	"calls" integer NOT NULL,
	"buyers" integer NOT NULL,
	"volume" bigint NOT NULL,
	"success_rate" double precision,
	"p50_ms" integer,
	"trend" jsonb NOT NULL,
	"counted_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "stats_services_host_check" CHECK (length("stats_services"."host") <= 259)
);
