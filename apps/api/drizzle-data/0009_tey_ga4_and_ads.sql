CREATE TABLE "ads_connections" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"google_account_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"login_customer_id" text NOT NULL,
	"descriptive_name" text NOT NULL,
	"time_zone" text,
	"currency_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ga4_connections" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"google_account_id" uuid NOT NULL,
	"property_id" text NOT NULL,
	"display_name" text NOT NULL,
	"time_zone" text,
	"currency_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ads_connections" ADD CONSTRAINT "ads_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_connections" ADD CONSTRAINT "ga4_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;