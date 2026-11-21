ALTER TABLE `sessions` ADD `last_active_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `locked` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Existing sessions count as active now, so turning on App lock doesn't lock them instantly.
UPDATE `sessions` SET `last_active_at` = unixepoch() * 1000;
