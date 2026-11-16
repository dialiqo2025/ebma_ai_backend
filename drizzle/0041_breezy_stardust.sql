ALTER TABLE "gpu_health_check_logs" ADD COLUMN "usage_percent" integer;--> statement-breakpoint
ALTER TABLE "gpu_health_check_logs" ADD COLUMN "active_workload" integer;--> statement-breakpoint
ALTER TABLE "gpu_health_check_logs" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "gpu_health_check_logs" ADD COLUMN "queue_depth" integer;--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD COLUMN "notify_healthy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD COLUMN "notify_high_usage" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD COLUMN "notify_unhealthy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD COLUMN "notify_recovered" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD COLUMN "high_usage_threshold_percent" integer DEFAULT 80 NOT NULL;--> statement-breakpoint
ALTER TABLE "gpu_health_monitor_settings" ADD COLUMN "repeat_alert_minutes" integer DEFAULT 60 NOT NULL;