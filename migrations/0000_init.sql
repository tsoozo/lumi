CREATE TABLE `admin_invites` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer,
	`actor_type` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer,
	`before` text,
	`after` text,
	`ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_logs_actor_type_chk" CHECK(actor_type IN ('user','admin','system','telegram'))
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `auth_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_codes_email_idx` ON `auth_codes` (`email`,`created_at`);--> statement-breakpoint
CREATE TABLE `bank_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`bank_name` text NOT NULL,
	`account_number_encrypted` text NOT NULL,
	`account_number_last4` text NOT NULL,
	`account_holder_name` text NOT NULL,
	`is_verified` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`locked_until` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bank_accounts_user_idx` ON `bank_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `bot_sessions` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`entity_id` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contest_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contest_id` integer NOT NULL,
	`file_url` text NOT NULL,
	`file_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contest_id`) REFERENCES `contests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contest_attachments_contest_idx` ON `contest_attachments` (`contest_id`);--> statement-breakpoint
CREATE TABLE `contests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`title` text NOT NULL,
	`category` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`requirements` text DEFAULT '' NOT NULL,
	`deliverable_formats` text DEFAULT '' NOT NULL,
	`budget` integer NOT NULL,
	`fee_percent` text DEFAULT '5.00' NOT NULL,
	`fee_amount` integer DEFAULT 0 NOT NULL,
	`prize_amount` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`payment_ref_code` text,
	`submission_days` integer DEFAULT 7 NOT NULL,
	`submission_deadline` integer,
	`selection_deadline` integer,
	`extended_count` integer DEFAULT 0 NOT NULL,
	`selection_reminders` integer DEFAULT 0 NOT NULL,
	`selection_grace_used` integer DEFAULT false NOT NULL,
	`published_at` integer,
	`no_refund_accepted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "contests_status_chk" CHECK(status IN ('draft','awaiting_payment','payment_review','pending_approval','active','selecting','handover','payout_pending','completed','extended','refund_pending','refunded','cancelled','disputed')),
	CONSTRAINT "contests_budget_chk" CHECK(budget >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contests_payment_ref_code_unique` ON `contests` (`payment_ref_code`);--> statement-breakpoint
CREATE INDEX `contests_status_idx` ON `contests` (`status`);--> statement-breakpoint
CREATE INDEX `contests_client_idx` ON `contests` (`client_id`);--> statement-breakpoint
CREATE INDEX `contests_status_sub_deadline_idx` ON `contests` (`status`,`submission_deadline`);--> statement-breakpoint
CREATE INDEX `contests_status_sel_deadline_idx` ON `contests` (`status`,`selection_deadline`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contest_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`preview_url` text,
	`watermarked_url` text NOT NULL,
	`original_file_url` text NOT NULL,
	`rating` integer,
	`is_finalist` integer DEFAULT false NOT NULL,
	`is_winner` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`removed_reason` text,
	`originality_confirmed_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contest_id`) REFERENCES `contests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "entries_status_chk" CHECK(status IN ('active','withdrawn','removed')),
	CONSTRAINT "entries_rating_chk" CHECK(rating IS NULL OR (rating BETWEEN 1 AND 5))
);
--> statement-breakpoint
CREATE INDEX `entries_contest_idx` ON `entries` (`contest_id`,`status`);--> statement-breakpoint
CREATE INDEX `entries_creator_idx` ON `entries` (`creator_id`);--> statement-breakpoint
CREATE TABLE `entry_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entry_comments_entry_idx` ON `entry_comments` (`entry_id`);--> statement-breakpoint
CREATE TABLE `handovers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contest_id` integer NOT NULL,
	`entry_id` integer NOT NULL,
	`final_files_url` text,
	`status` text DEFAULT 'waiting_files' NOT NULL,
	`files_deadline` integer NOT NULL,
	`files_sent_at` integer,
	`accept_deadline` integer,
	`accepted_at` integer,
	`ip_agreement_client_at` integer,
	`ip_agreement_creator_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contest_id`) REFERENCES `contests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "handovers_status_chk" CHECK(status IN ('waiting_files','files_sent','accepted','auto_accepted','disputed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `handovers_contest_id_unique` ON `handovers` (`contest_id`);--> statement-breakpoint
CREATE INDEX `handovers_status_idx` ON `handovers` (`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`read_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contest_id` integer NOT NULL,
	`payer_id` integer NOT NULL,
	`expected_amount` integer NOT NULL,
	`reported_amount` integer NOT NULL,
	`received_amount` integer,
	`payer_bank_name` text NOT NULL,
	`payer_account_name` text NOT NULL,
	`transfer_note` text NOT NULL,
	`receipt_image_url` text,
	`status` text DEFAULT 'reported' NOT NULL,
	`bank_transaction_ref` text,
	`reviewed_by` integer,
	`reviewed_at` integer,
	`reject_reason` text,
	`telegram_message_id` text,
	`last_reminder_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contest_id`) REFERENCES `contests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_status_chk" CHECK(status IN ('reported','confirmed','rejected','amount_mismatch'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_bank_transaction_ref_unique` ON `payments` (`bank_transaction_ref`);--> statement-breakpoint
CREATE INDEX `payments_contest_idx` ON `payments` (`contest_id`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`);--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contest_id` integer NOT NULL,
	`recipient_id` integer NOT NULL,
	`bank_account_id` integer,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`bank_transaction_ref` text,
	`proof_image_url` text,
	`fail_reason` text,
	`due_at` integer NOT NULL,
	`sent_by` integer,
	`sent_at` integer,
	`telegram_message_id` text,
	`reminder_sent_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contest_id`) REFERENCES `contests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payouts_type_chk" CHECK(type IN ('prize','split_prize','refund')),
	CONSTRAINT "payouts_status_chk" CHECK(status IN ('pending','sent','failed')),
	CONSTRAINT "payouts_amount_chk" CHECK(amount > 0)
);
--> statement-breakpoint
CREATE INDEX `payouts_contest_idx` ON `payouts` (`contest_id`);--> statement-breakpoint
CREATE INDEX `payouts_status_idx` ON `payouts` (`status`);--> statement-breakpoint
CREATE INDEX `payouts_recipient_idx` ON `payouts` (`recipient_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payouts_contest_recipient_type_uq` ON `payouts` (`contest_id`,`recipient_id`,`type`);--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contest_id` integer NOT NULL,
	`entry_id` integer,
	`reporter_id` integer NOT NULL,
	`reason` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` integer,
	`resolution` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`contest_id`) REFERENCES `contests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reports_status_chk" CHECK(status IN ('open','resolved','rejected'))
);
--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`email` text NOT NULL,
	`phone` text,
	`google_id` text,
	`full_name` text,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`admin_level` text,
	`telegram_chat_id` text,
	`is_banned` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "users_role_chk" CHECK(role IN ('user','admin')),
	CONSTRAINT "users_admin_level_chk" CHECK(admin_level IS NULL OR admin_level IN ('reviewer','finance','super'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_chat_id_unique` ON `users` (`telegram_chat_id`);