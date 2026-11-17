# PosFlow

نظام نقاط بيع ومحاسبة (React + Vite + Capacitor + Electron) على قاعدة Supabase.

## التشغيل المحلي

```
npm ci
cp .env.example .env   # املأ VITE_SUPABASE_URL و VITE_SUPABASE_PUBLISHABLE_KEY و VITE_SUPABASE_PROJECT_ID
npm run dev
```

## قاعدة البيانات والدوال

- الـ SQL يُكتب فقط داخل `supabase/migrations/` وتُطبَّق بـ `supabase db push`.
- الدوال في `supabase/functions/` وتُنشر بـ `supabase functions deploy <name> --project-ref <ref>`.
- ضع `project_id` الصحيح في `supabase/config.toml`.

### أسرار الدوال المطلوبة (Supabase → Edge Functions → Secrets)

| السر | الاستخدام |
|------|-----------|
| `TELEGRAM_BOT_TOKEN` | بوت تيليجرام (`telegram-auth`) |
| `TELEGRAM_BOT_USERNAME` | اسم البوت |
| `GITHUB_TOKEN` | قراءة/نشر الإصدارات (`get-main-version`، `publish-telegram-release`، `trigger-public-release`) |
| `GITHUB_REPO` | اختياري، الافتراضي `almhtrf111312/posflowapp` |

## النشر

- الويب: Cloudflare Pages (ربط المستودع، أمر البناء `npm run build`، مجلد الإخراج `dist`).
- أندرويد وويندوز: عبر GitHub Actions في `.github/workflows/`.
