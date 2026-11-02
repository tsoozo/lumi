export interface Env {
  DB: D1Database;
  PRIVATE_FILES: R2Bucket;
  PUBLIC_FILES: R2Bucket;
  ASSETS?: Fetcher;
  APP_URL: string;
  R2_ACCOUNT_ID: string;
  PUBLIC_FILES_BASE_URL: string;
  EMAIL_FROM: string;
  // secrets (wrangler secret put)
  SESSION_SECRET: string;
  BANK_ENCRYPTION_KEY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
}
