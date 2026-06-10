CREATE TABLE `invocations` (
	`id` text PRIMARY KEY,
	`ts_ms` integer NOT NULL,
	`function_name` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`user_id` text,
	`backend` text NOT NULL,
	`error_kind` text,
	`error_message` text,
	`error_stack` text
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`invocation_id` text,
	`ts_ms` integer NOT NULL,
	`level` text NOT NULL,
	`function_name` text,
	`source` text DEFAULT 'function' NOT NULL,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_invocations_ts` ON `invocations` (`ts_ms`);--> statement-breakpoint
CREATE INDEX `idx_invocations_fn_ts` ON `invocations` (`function_name`,`ts_ms`);--> statement-breakpoint
CREATE INDEX `idx_invocations_status_ts` ON `invocations` (`status`,`ts_ms`);--> statement-breakpoint
CREATE INDEX `idx_logs_invocation` ON `logs` (`invocation_id`);--> statement-breakpoint
CREATE INDEX `idx_logs_ts` ON `logs` (`ts_ms`);