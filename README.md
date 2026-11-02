# Lumi — баталгаат дизайны уралдааны платформ

Захиалагч төсвөө тавиад уралдаан зарлана, хэн ч оролцож болно, захиалагч бүх бүтээлийг харна, гэхдээ **зөвхөн ялагчийнхыг** ашиглах эрхтэй. Ялагч төсвийн 95%-ийг, платформ 5%-ийг авна. Төлбөрийн шлюз байхгүй: мөнгө орох/гарах бүрийг админ банкны аппаасаа шалгаж Telegram bot (эсвэл вэб самбар)-аар баталгаажуулна.

Бүгд Cloudflare-ийн үнэгүй багц дээр: нэг Worker (Hono API + React SPA + grammY bot + cron), D1 (SQLite) + Drizzle, R2.

## Бүтэц

```
src/
  worker.ts            Worker entry: /api/*, Telegram webhook, cron (scheduled)
  db/schema.ts         Drizzle схем (TEXT+CHECK enum, мөнгө = INTEGER ₮, огноо = unix сек)
  services/            Бизнес логик — вэб API ба Telegram ХОЁУЛАА эдгээрийг дуудна
    contestState.ts    Төлөвийн машин: зөвшөөрөгдсөн шилжилт + хамгаалагдсан UPDATE
    contests.ts        Ноорог, төлбөр рүү шилжих (UB-XXXXX код), жагсаалт
    payments.ts        "Шилжүүлсэн" → Орсон / Дүн зөрүүтэй / Ороогүй
    entries.ts         Бүтээл (blind, ≤3), од, сэтгэгдэл, эцсийн шат, ялагч, сунгалт, буцаалт
    handovers.ts       Эх файл, зохиогчийн эрхийн гэрээ, хүлээн авалт → payout
    payouts.ts         Гарах төлбөр, данс солигдвол 48 цаг түгжих, давхар баталгаа
    lifecycle.ts       Cron: хугацаа, сануулга, +7 хоног, тэнцүү хуваалт, авто хүлээн авалт
    admin.ts           Нийтлэх/татгалзах, админ урих, /today тайлан, audit
    users.ts           Имэйл кодоор нэвтрэх (нууц үггүй), банкны данс (AES-GCM шифрлэлт)
    uploads.ts         R2 presigned upload/download, файлын төрөл/хэмжээ шалгах
  bot/                 Telegram bot (зөвхөн админд)
  routes/api.ts        REST endpoint-ууд
web/                   React + Vite + Tailwind (watermark хөтөч дээр canvas-аар)
migrations/            D1 migration (drizzle-kit generate)
test/                  Vitest: бүтэн мөнгөний тойрог + дүрмүүд (жинхэнэ local D1 дээр)
```

## Local-д ажиллуулах

```bash
npm install
cp .dev.vars.example .dev.vars        # SESSION_SECRET, BANK_ENCRYPTION_KEY (openssl rand -base64 32), BOOTSTRAP_ADMIN_EMAIL
npm run db:migrate:local
npm run dev:worker                    # build + wrangler dev → http://localhost:8787
```

- Имэйлийн API түлхүүргүй үед нэвтрэх код **wrangler-ийн консолд** хэвлэгдэнэ.
- `BOOTSTRAP_ADMIN_EMAIL`-ээр анх нэвтэрсэн хүн супер админ болно. Админ → Тохиргоо хэсэгт системийн дансаа (`system_bank_name`, `system_account_number`, `system_account_holder`) оруулна. Үүнгүйгээр уралдаан төлбөр рүү шилжихгүй.
- R2 S3 түлхүүргүй үед файл Worker-оор дамжин орно (зөвхөн хөгжүүлэлтэд).
- Frontend-ийг hot reload-той: нэг терминалд `npx wrangler dev`, нөгөөд `npm run dev` (Vite /api-г 8787 руу proxy хийнэ).

```bash
npm test          # 18 тест: unit + бүтэн урсгал
npm run typecheck
```

## Cloudflare-д байршуулах

```bash
npx wrangler login
npx wrangler d1 create lumi-db                 # гарсан database_id-г wrangler.toml-д бичнэ
npx wrangler r2 bucket create lumi-private
npx wrangler r2 bucket create lumi-public      # Dashboard-оос r2.dev public access асаагаад URL-ийг PUBLIC_FILES_BASE_URL-д
npm run db:migrate:remote

npx wrangler secret put SESSION_SECRET
npx wrangler secret put BANK_ENCRYPTION_KEY    # openssl rand -base64 32 — АЛДВАЛ дансны дугаарууд уншигдахгүй
npx wrangler secret put TELEGRAM_BOT_TOKEN     # @BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put R2_ACCESS_KEY_ID       # R2 → Manage API tokens (Object Read & Write)
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL

# wrangler.toml [vars]: APP_URL, R2_ACCOUNT_ID, PUBLIC_FILES_BASE_URL, EMAIL_FROM
npm run deploy

# Telegram webhook-ийг нэг удаа:
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://lumi.<таны-нэр>.workers.dev/api/telegram/webhook/<WEBHOOK_SECRET>" \
  -d "secret_token=<WEBHOOK_SECRET>" -d 'allowed_updates=["message","callback_query"]'
```

R2 bucket-д CORS тохируулна (хөтөч presigned URL руу шууд PUT хийнэ): `AllowedOrigins: [APP_URL]`, `AllowedMethods: [PUT, GET]`, `AllowedHeaders: [Content-Type]`.

## Админ бүртгэх (Telegram)

1. Супер админ вэб самбар → Админ → имэйл + түвшин → "Код үүсгэх" (15 минут).
2. Шинэ админ bot-д `/start <код>` илгээнэ. Үүнээс хойш bot зөвхөн бүртгэлтэй chat ID-аас ирсэн товчийг хүлээж авна.

Командууд: `/pending`, `/payouts`, `/contest UB-XXXXX`, `/reports`, `/today`.

## Мөнгөтэй холбоотой хамгаалалтууд

- Төлөв солих бүр `UPDATE … WHERE status = <хүлээгдэж буй>` — 2 админ зэрэг дарах, давхар товшилт, cron 2 удаа ажиллах нь дүнг өөрчлөхгүй (тестээр шалгасан).
- Нэг банкны гүйлгээний дугаар нэг л төлбөрт (UNIQUE).
- Дүнг систем тооцно, админ гараар оруулахгүй. Шимтгэлийн хувь уралдаан бүрт хадгалагдана.
- Тэнцүү хуваахад үлдэгдэл төгрөгийг эхний оролцогчид нэмнэ; нэг оролцогч хэд ч бүтээл оруулсан нэг л хувь авна.
- Данс солиход имэйл код; payout хүлээгдэж байхад солибол 48 цаг түгжинэ; эзэмшигчийн нэр профайлтай таарахгүй бол админд ⚠️.
- Буцаалтыг зөвхөн төлбөр ирсэн данс руу (bot мессежинд харуулна).
- Эх файл хаалттай R2-д, 10 минутын presigned URL; бусад оролцогчийн эх файл хэзээ ч гарахгүй.
- Бүх чухал үйлдэл `audit_logs`-д.

## Шийдвэр гаргасан, spec-д тодорхойгүй байсан зүйлс

- **`extended` төлөв** = 3-аас цөөн бүтээл ирсэн үед захиалагч сунгасан уралдаан (бүтээл хүлээн авна). Нэг л удаа.
- **Ялагч эх файлаа 3 хоногт илгээхгүй бол** уралдаан `disputed` болж админд мэдэгдэнэ (мөнгө автоматаар хөдлөхгүй).
- **Ялагч сонгох сануулга**: хугацаа дуусахаас өмнөх 2 өдөрт өдөрт нэг, дараа нь +7 хоног, тэгээд тэнцүү хуваалт.
- **Бүтээл 0 ирээд** сонгох хугацаа дуусвал автоматаар 100% буцаалт.
- **Дүн зөрүүтэй** үед үлдэгдлийг нэмж шилжүүлэх (шинэ "Шилжүүлсэн") эсвэл орсон дүнгээ буцааж авах.
- Ажлын өдөр = Да–Ба (УБ цаг); нийтийн амралтын өдрийг тооцоогүй.

## Дараагийн алхам (2-р шат)

Маргааны бүрэн урсгал (админ самбараас `disputed`-ийг шийдэх), perceptual hash, оролцогчийн рейтинг/портфолио, Google нэвтрэлт, хэрэглэгчийн Telegram мэдэгдэл.
