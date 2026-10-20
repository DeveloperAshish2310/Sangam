CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`status_message` text,
	`credentials` text,
	`sync_state` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_channel_external` ON `accounts` (`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`action` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text,
	`unread` integer DEFAULT 0 NOT NULL,
	`starred` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`last_message_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_account_external` ON `conversations` (`account_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `conversations_last` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`direction` text NOT NULL,
	`sender_name` text,
	`text` text DEFAULT '' NOT NULL,
	`html` text,
	`sent_at` integer NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_external` ON `messages` (`conversation_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_sent` ON `messages` (`conversation_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
