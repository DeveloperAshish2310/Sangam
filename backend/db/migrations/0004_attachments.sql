CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`mime` text DEFAULT 'application/octet-stream' NOT NULL,
	`size` integer,
	`ref` text NOT NULL,
	`cached` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_message_key` ON `attachments` (`message_id`,`key`);