CREATE TABLE `todos` (
	`id` text PRIMARY KEY NOT NULL,
	`item` text NOT NULL,
	`email_thread_id` text,
	FOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todos_id_unique` ON `todos` (`id`);