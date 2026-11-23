# ملاحظات المشروع الدائمة (Standing Project Notes)

> مرجع تحت الطلب. حقائق ثابتة عن المزامنة والتحديثات والإصدار. منقولة حرفياً من `AGENTS.md` القديم.

- Warehouses & Stock Transfer (custody) are DISABLED: pages `src/pages/Warehouses.tsx`, `src/pages/StockTransfer.tsx`, `src/lib/cloud/warehouses-cloud.ts`. Routes redirect to `/`, menu entries commented out. Do not read, audit, or edit these files unless the owner explicitly asks to re-enable them — saves credits. (`use-warehouse.tsx` stays active because POS depends on it.)

- Offline writes (customers, expenses, debts, debt payments) queue via sync-queue with client UUIDs; expenses go through the add_expense_atomic RPC. Why: queue-first UI with retry-safe, duplicate-free sync.

- Remote release control lives in `src/lib/remote-updates.ts` (config in app_settings key `release_config`, broadcasts in `app_broadcasts`, installs in `client_versions`); the Boss is never locked out. Why: one source for forced-update rules.

- Keep active tab ancestors free of transforms and perspective; floating controls stay inline and viewport-fixed. Scroll visibility resets on page activation and ignores automatic layout/restoration scrolls so cached pages do not hide their controls on entry.

- Save and restore portable settings and product/custom-field preferences through the unified settings module and its offline queue; preserve explicit empty arrays and use timestamp-guarded pulls. Why: independent writes or unguarded realtime pulls can lose offline edits.
- Store appearance profiles by platform within stores.sync_settings and merge profiles when saving; keep printer pairing and notification permission device-local. Why: restore appearance without one platform overwriting another or copying hardware identities.
- Telegram channel posts use only changelog `public` notes (new/improved/fixed), built by scripts/telegram-release-notes.cjs; add a plain user-facing line per release. Why: internal notes (Boss, GitHub, branches) must never reach users.
- Telegram release uses workflow_dispatch with an main-branch checkout (no public-release branch) and confirmation gate; keep ordinary branch builds separate. Why: the owner controls which source is published without branch merges or accidental dispatches.
- Boss release panel reads the latest version from GitHub main via the get-main-version function, not the installed bundle. Why: the panel must see new builds before the Boss updates his own app.

- SQL and edge-function changes are made only through files in `supabase/migrations/` and `supabase/functions/`, applied manually by the owner. Rollback scripts for recent migrations live in `supabase/live-snapshots/` (`ROLLBACK_*.sql`, named in each migration header). Why: one source of truth, no conflicting fixes.