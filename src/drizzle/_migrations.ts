/**
 * This file is auto-generated. Do not edit directly.
 * Generated on: 2025-03-26T01:51:11.045Z
 */

export interface Migration {
  hash: string;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    "hash": "0000_redundant_vargas",
    "name": "0000_redundant_vargas.sql",
    "sql": "CREATE TABLE `chat_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`content` text NOT NULL,\n\t`attachments` text,\n\t`role` text NOT NULL,\n\t`annotations` text,\n\t`parts` text,\n\t`chat_thread_id` text NOT NULL,\n\tFOREIGN KEY (`chat_thread_id`) REFERENCES `chat_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_messages_id_unique` ON `chat_messages` (`id`);--> statement-breakpoint\nCREATE TABLE `chat_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `chat_threads_id_unique` ON `chat_threads` (`id`);--> statement-breakpoint\nCREATE TABLE `email_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`message_id` text NOT NULL,\n\t`html_body` text NOT NULL,\n\t`text_body` text NOT NULL,\n\t`parts` text NOT NULL,\n\t`subject` text,\n\t`date` text NOT NULL,\n\t`from` text NOT NULL,\n\t`in_reply_to` text,\n\t`email_thread_id` text,\n\tFOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`) ON UPDATE cascade ON DELETE set null\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_id_unique` ON `email_messages` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `email_messages_message_id_unique` ON `email_messages` (`message_id`);--> statement-breakpoint\nCREATE TABLE `email_threads` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`subject` text NOT NULL,\n\t`date` text NOT NULL,\n\t`root_message_id` text\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `email_threads_id_unique` ON `email_threads` (`id`);--> statement-breakpoint\nCREATE TABLE `embeddings` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`email_message_id` text,\n\t`email_thread_id` text,\n\t`embedding` F32_BLOB(384),\n\t`as_text` text,\n\tFOREIGN KEY (`email_message_id`) REFERENCES `email_messages`(`id`) ON UPDATE cascade ON DELETE cascade,\n\tFOREIGN KEY (`email_thread_id`) REFERENCES `email_threads`(`id`) ON UPDATE cascade ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_id_unique` ON `embeddings` (`id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_message_id_unique` ON `embeddings` (`email_message_id`);--> statement-breakpoint\nCREATE UNIQUE INDEX `embeddings_email_thread_id_unique` ON `embeddings` (`email_thread_id`);--> statement-breakpoint\nCREATE TABLE `settings` (\n\t`key` text PRIMARY KEY NOT NULL,\n\t`value` text,\n\t`updated_at` text DEFAULT (CURRENT_DATE)\n);\n--> statement-breakpoint\nCREATE TABLE `todos` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`item` text NOT NULL,\n\t`imap_id` text,\n\tFOREIGN KEY (`imap_id`) REFERENCES `email_messages`(`message_id`) ON UPDATE cascade ON DELETE set null\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `todos_id_unique` ON `todos` (`id`);"
  },
  {
    "hash": "0001_concerned_molten_man",
    "name": "0001_concerned_molten_man.sql",
    "sql": "PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_todos` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`item` text NOT NULL,\n\t`imap_id` text\n);\n--> statement-breakpoint\nINSERT INTO `__new_todos`(\"id\", \"item\", \"imap_id\") SELECT \"id\", \"item\", \"imap_id\" FROM `todos`;--> statement-breakpoint\nDROP TABLE `todos`;--> statement-breakpoint\nALTER TABLE `__new_todos` RENAME TO `todos`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;--> statement-breakpoint\nCREATE UNIQUE INDEX `todos_id_unique` ON `todos` (`id`);"
  }
];
