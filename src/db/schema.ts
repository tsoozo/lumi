// Cloudflare D1 (SQLite) schema.
// Rules: money is INTEGER (₮), timestamps are INTEGER unix seconds, enums are TEXT + CHECK,
// JSON is TEXT. Money-related rows are never deleted, only their status changes.
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch())`;
const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} IN (${values.map((v) => `'${v}'`).join(",")})`);

export const CONTEST_STATUSES = [
  "draft",
  "awaiting_payment",
  "payment_review",
  "pending_approval",
  "active",
  "selecting",
  "handover",
  "payout_pending",
  "completed",
  "extended",
  "refund_pending",
  "refunded",
  "cancelled",
  "disputed",
] as const;
export type ContestStatus = (typeof CONTEST_STATUSES)[number];

export const PAYMENT_STATUSES = ["reported", "confirmed", "rejected", "amount_mismatch"] as const;
export const ENTRY_STATUSES = ["active", "withdrawn", "removed"] as const;
export const HANDOVER_STATUSES = ["waiting_files", "files_sent", "accepted", "auto_accepted", "disputed"] as const;
export const PAYOUT_TYPES = ["prize", "split_prize", "refund"] as const;
export const PAYOUT_STATUSES = ["pending", "sent", "failed"] as const;
export const REPORT_STATUSES = ["open", "resolved", "rejected"] as const;
export const ADMIN_LEVELS = ["reviewer", "finance", "super"] as const;
export type AdminLevel = (typeof ADMIN_LEVELS)[number];
export const ACTOR_TYPES = ["user", "admin", "system", "telegram"] as const;

// ---------------------------------------------------------------- users
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    phone: text("phone"),
    googleId: text("google_id"),
    fullName: text("full_name"),
    displayName: text("display_name"),
    role: text("role").notNull().default("user"),
    adminLevel: text("admin_level"),
    telegramChatId: text("telegram_chat_id").unique(),
    isBanned: integer("is_banned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    check("users_role_chk", inList("role", ["user", "admin"])),
    check("users_admin_level_chk", sql`admin_level IS NULL OR ${inList("admin_level", ADMIN_LEVELS)}`),
  ],
);

export const bankAccounts = sqliteTable(
  "bank_accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    bankName: text("bank_name").notNull(),
    accountNumberEncrypted: text("account_number_encrypted").notNull(),
    accountNumberLast4: text("account_number_last4").notNull(),
    accountHolderName: text("account_holder_name").notNull(),
    isVerified: integer("is_verified", { mode: "boolean" }).notNull().default(false),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    // Account changed while a payout was pending -> payouts to it are locked for 48h.
    lockedUntil: integer("locked_until"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("bank_accounts_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------- contests
export const contests = sqliteTable(
  "contests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    clientId: integer("client_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull().default(""),
    requirements: text("requirements").notNull().default(""),
    deliverableFormats: text("deliverable_formats").notNull().default(""),
    budget: integer("budget").notNull(),
    feePercent: text("fee_percent").notNull().default("5.00"), // NUMERIC(4,2) kept exact as text
    feeAmount: integer("fee_amount").notNull().default(0),
    prizeAmount: integer("prize_amount").notNull().default(0),
    status: text("status").$type<ContestStatus>().notNull().default("draft"),
    paymentRefCode: text("payment_ref_code").unique(),
    submissionDays: integer("submission_days").notNull().default(7),
    submissionDeadline: integer("submission_deadline"),
    selectionDeadline: integer("selection_deadline"),
    extendedCount: integer("extended_count").notNull().default(0),
    selectionReminders: integer("selection_reminders").notNull().default(0),
    selectionGraceUsed: integer("selection_grace_used", { mode: "boolean" }).notNull().default(false),
    publishedAt: integer("published_at"),
    noRefundAcceptedAt: integer("no_refund_accepted_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    check("contests_status_chk", inList("status", CONTEST_STATUSES)),
    check("contests_budget_chk", sql`budget >= 0`),
    index("contests_status_idx").on(t.status),
    index("contests_client_idx").on(t.clientId),
    index("contests_status_sub_deadline_idx").on(t.status, t.submissionDeadline),
    index("contests_status_sel_deadline_idx").on(t.status, t.selectionDeadline),
  ],
);

export const contestAttachments = sqliteTable(
  "contest_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull().references(() => contests.id),
    fileUrl: text("file_url").notNull(), // R2 key in PUBLIC_FILES
    fileName: text("file_name").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("contest_attachments_contest_idx").on(t.contestId)],
);

// ---------------------------------------------------------------- payments (client -> system)
export const payments = sqliteTable(
  "payments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull().references(() => contests.id),
    payerId: integer("payer_id").notNull().references(() => users.id),
    expectedAmount: integer("expected_amount").notNull(),
    reportedAmount: integer("reported_amount").notNull(),
    receivedAmount: integer("received_amount"), // set by admin on confirm / mismatch
    payerBankName: text("payer_bank_name").notNull(),
    payerAccountName: text("payer_account_name").notNull(),
    transferNote: text("transfer_note").notNull(),
    receiptImageUrl: text("receipt_image_url"),
    status: text("status").notNull().default("reported"),
    bankTransactionRef: text("bank_transaction_ref").unique(), // one bank tx can confirm only one payment
    reviewedBy: integer("reviewed_by").references(() => users.id),
    reviewedAt: integer("reviewed_at"),
    rejectReason: text("reject_reason"),
    telegramMessageId: text("telegram_message_id"), // "chatId:messageId[,chatId:messageId]"
    lastReminderAt: integer("last_reminder_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    check("payments_status_chk", inList("status", PAYMENT_STATUSES)),
    index("payments_contest_idx").on(t.contestId),
    index("payments_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------- entries
export const entries = sqliteTable(
  "entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull().references(() => contests.id),
    creatorId: integer("creator_id").notNull().references(() => users.id),
    title: text("title").notNull().default(""),
    description: text("description").notNull().default(""),
    previewUrl: text("preview_url"), // PUBLIC_FILES key (low-res)
    watermarkedUrl: text("watermarked_url").notNull(), // PUBLIC_FILES key
    originalFileUrl: text("original_file_url").notNull(), // PRIVATE_FILES key
    rating: integer("rating"),
    isFinalist: integer("is_finalist", { mode: "boolean" }).notNull().default(false),
    isWinner: integer("is_winner", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("active"),
    removedReason: text("removed_reason"),
    originalityConfirmedAt: integer("originality_confirmed_at").notNull(),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    check("entries_status_chk", inList("status", ENTRY_STATUSES)),
    check("entries_rating_chk", sql`rating IS NULL OR (rating BETWEEN 1 AND 5)`),
    index("entries_contest_idx").on(t.contestId, t.status),
    index("entries_creator_idx").on(t.creatorId),
  ],
);

export const entryComments = sqliteTable(
  "entry_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: integer("entry_id").notNull().references(() => entries.id),
    authorId: integer("author_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("entry_comments_entry_idx").on(t.entryId)],
);

// ---------------------------------------------------------------- handovers
export const handovers = sqliteTable(
  "handovers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull().references(() => contests.id).unique(),
    entryId: integer("entry_id").notNull().references(() => entries.id),
    finalFilesUrl: text("final_files_url"), // PRIVATE_FILES key(s), JSON array
    status: text("status").notNull().default("waiting_files"),
    filesDeadline: integer("files_deadline").notNull(),
    filesSentAt: integer("files_sent_at"),
    acceptDeadline: integer("accept_deadline"),
    acceptedAt: integer("accepted_at"),
    ipAgreementClientAt: integer("ip_agreement_client_at"),
    ipAgreementCreatorAt: integer("ip_agreement_creator_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    check("handovers_status_chk", inList("status", HANDOVER_STATUSES)),
    index("handovers_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------- payouts (system -> winner / refund)
export const payouts = sqliteTable(
  "payouts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull().references(() => contests.id),
    recipientId: integer("recipient_id").notNull().references(() => users.id),
    bankAccountId: integer("bank_account_id").references(() => bankAccounts.id), // NULL until recipient registers an account
    type: text("type").notNull(),
    amount: integer("amount").notNull(),
    status: text("status").notNull().default("pending"),
    bankTransactionRef: text("bank_transaction_ref"),
    proofImageUrl: text("proof_image_url"),
    failReason: text("fail_reason"),
    dueAt: integer("due_at").notNull(), // 3 business days
    sentBy: integer("sent_by").references(() => users.id),
    sentAt: integer("sent_at"),
    telegramMessageId: text("telegram_message_id"),
    reminderSentAt: integer("reminder_sent_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    check("payouts_type_chk", inList("type", PAYOUT_TYPES)),
    check("payouts_status_chk", inList("status", PAYOUT_STATUSES)),
    check("payouts_amount_chk", sql`amount > 0`),
    index("payouts_contest_idx").on(t.contestId),
    index("payouts_status_idx").on(t.status),
    index("payouts_recipient_idx").on(t.recipientId),
    // Idempotency: one payout per contest+recipient+type
    uniqueIndex("payouts_contest_recipient_type_uq").on(t.contestId, t.recipientId, t.type),
  ],
);

// ---------------------------------------------------------------- reports
export const reports = sqliteTable(
  "reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contestId: integer("contest_id").notNull().references(() => contests.id),
    entryId: integer("entry_id").references(() => entries.id),
    reporterId: integer("reporter_id").notNull().references(() => users.id),
    reason: text("reason").notNull(),
    details: text("details").notNull().default(""),
    status: text("status").notNull().default("open"),
    resolvedBy: integer("resolved_by").references(() => users.id),
    resolution: text("resolution"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [check("reports_status_chk", inList("status", REPORT_STATUSES)), index("reports_status_idx").on(t.status)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull().references(() => users.id),
    type: text("type").notNull(),
    payload: text("payload").notNull().default("{}"),
    readAt: integer("read_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    actorId: integer("actor_id").references(() => users.id),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id"),
    before: text("before"),
    after: text("after"),
    ip: text("ip"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    check("audit_logs_actor_type_chk", inList("actor_type", ACTOR_TYPES)),
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------- support tables (auth, settings, bot)
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(now),
});

export const authCodes = sqliteTable(
  "auth_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("auth_codes_email_idx").on(t.email, t.createdAt)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const adminInvites = sqliteTable("admin_invites", {
  codeHash: text("code_hash").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  createdAt: integer("created_at").notNull().default(now),
});

// Multi-step Telegram dialogs (e.g. "how much arrived?", "send tx ref")
export const botSessions = sqliteTable("bot_sessions", {
  chatId: text("chat_id").primaryKey(),
  action: text("action").notNull(),
  entityId: integer("entity_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export type User = typeof users.$inferSelect;
export type Contest = typeof contests.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Entry = typeof entries.$inferSelect;
export type Payout = typeof payouts.$inferSelect;
export type Handover = typeof handovers.$inferSelect;
