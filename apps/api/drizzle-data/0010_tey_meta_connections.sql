CREATE TABLE "meta_connections" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"meta_account_id" uuid NOT NULL,
	"ad_account_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text,
	"time_zone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meta_connections" ADD CONSTRAINT "meta_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;