# AGENTS.md — PosFlow (the single constitution for every AI agent)

> `CLAUDE.md` only imports this file. Hard limit: 120 lines. Detail lives in `MAP.md` files and `docs/`
> (read on demand) — never copy it here. Owner-facing language: Arabic. Commits/code: English.

## Stack
Offline-first POS. React 18 + Vite 7 + TypeScript + Tailwind/shadcn(Radix); Supabase (Postgres, RLS, RPC,
Edge Functions); Capacitor 8 (Android) and Electron (Windows). App id `com.posflow.app`. Base currency USD.
Local state: `src/lib/*-store.ts` + IndexedDB + `sync-queue.ts` (+ Capacitor SQLite). Arabic RTL UI (+EN/TR/FA/KU).

## Commands
- `npm ci` · `npm run dev` · `npm run lint` · `npm run build` (must exit 0 before any commit).
- Typecheck: `npx tsc --noEmit -p tsconfig.app.json` (bare `npx tsc --noEmit` checks NOTHING — root
  tsconfig has `"files": []`). A few old errors exist; add none.
- Finance gates: `npm run finance:check` + `npm run finance:sql` (mandatory for financial work, see below).
- Maps: `npm run maps` (regenerate) · `npm run maps:check` (fails if stale/missing; CI runs it).
- E2E: `npm run e2e`, `npm run e2e:stress`. No unit-test runner is installed.
- Version bump is automatic (`scripts/bump-version.js`, CI on main). Never hand-edit version fields.

## Session start
Run `git fetch`, then state only: version (`version.json`), last commit (`git log -1 --oneline`), branch.

## Folder map (every folder → its MAP.md)
| folder | one line | map |
|---|---|---|
| `src/` | app source; start at the index | `src/MAP.md` |
| `src/pages/` | one file per screen | `src/pages/MAP.md` |
| `src/components/` | UI by feature (pos, settings, reports…); `ui/` = shadcn, never read | `src/components/MAP.md` + per-feature `MAP.md` |
| `src/hooks/` | React hooks (auth, currency, network, license…) | `src/hooks/MAP.md` |
| `src/lib/` | domain logic, local stores, money/profit engines, queue | `src/lib/MAP.md` |
| `src/lib/cloud/` | Supabase access per domain — every RPC call lives here | `src/lib/cloud/MAP.md` |
| `src/lib/{db,printer,locales}/` | native SQLite · printing · translations | their own `MAP.md` |
| `supabase/` | migrations = SQL truth; RPC → args → newest migration | `supabase/MAP.md` |
| `supabase/functions/` | Edge Functions (Deno) | `supabase/functions/MAP.md` |
| `electron/` | Windows shell | `electron/MAP.md` |
| `android/app/src/` | custom native Android plugins | `android/app/src/MAP.md` |
| `scripts/` | build, release, maintenance, e2e scripts | `scripts/MAP.md` |
| `.github/workflows/` | CI (`build-apk.yml` = signed APK) | `.github/workflows/MAP.md` |
| `docs/` | on-demand references (list below) | — |
| `landing/` `public/` `resources/` `drizzle/` | landing page · static assets · icons · legacy migrations (`drizzle/migrations/0004_*` = profit SQL) | — |

## MANDATORY AI RULES (قواعد إلزامية)
1. ممنوع استخدام أدوات البحث الشامل (grep/find) عبر المشروع بالكامل قبل قراءة ملف `MAP.md` الخاص بالمجلد المستهدف.
2. قبل تعديل أي كود، يجب قراءة `MAP.md` الخاص بالوحدة لتحديد الملفات الدقيقة وعدم قراءة ملفات غير ذات صلة.
3. لا يُسمح بإنهاء أي مهمة برمجية تتضمن إضافة/حذف ملفات أو تغيير واجهات دوال (Signatures) دون تحديث ملف `MAP.md` المقابل أولاً.

How to obey them: path = `AGENTS.md` → `src/MAP.md` (or `supabase/MAP.md`) → the target folder's `MAP.md` → only the
files it lists. To "update MAP.md": add/adjust that file's one-line role in `scripts/map-descriptions.json`
(delete the entry when a file is deleted), run `npm run maps`, make `npm run maps:check` pass. Never hand-edit a `MAP.md`.
After reading a map, scoped greps inside the target folder are fine.

## FINANCIAL LOGIC — mandatory (القانون المالي)
Any task that touches money, profit, tax, debts, drawer/shifts, refunds, partners, expenses or purchases — or any review of them — is bound by
`docs/FINANCE_LAW.md` (scope in its §0). Read it fully BEFORE starting. It is not optional and no error is tolerated:
1. The law wins over code/SQL. A difference is a deviation to report; never change financial behaviour without the owner's explicit approval.
2. Done = gates, not opinion: `npm run finance:check` GREEN + build/types/maps + a production-code test for every rule you changed
   + the reconciliation queries when SQL or a money data flow changed. Paste the real output.
3. A reviewer may block only with a violated `F-xx` (or a RED gate) plus evidence; everything else is a non-blocking suggestion. List all
   blockers in one pass; never reopen verified work in unchanged files.
4. Fix and retry until every gate is green; the same check failing 3 rounds in a row = stop and report. Never weaken a check or edit an
   expected value to get green.

## Project invariants (violating one is a critical regression)
1. **FROZEN — never read or edit:** `src/pages/Warehouses.tsx`, `src/pages/StockTransfer.tsx`,
   `src/lib/cloud/warehouses-cloud.ts` (`use-warehouse.tsx` stays active; POS depends on it).
2. **Money:** USD is the only accounting base; other currencies are display/collection via the invoice's
   rate snapshot (`CurrencySnapshot`). Never hardcode `$`/symbols/rates — use `resolveInvoiceCurrencySymbol` /
   `formatCurrency`. No float approximations: `round8`/`roundCurrency`, 8 decimals internally. Law: `docs/FINANCE_LAW.md`.
3. **Atomic accounting:** sales, refunds, debts, expenses, partners, purchases go through atomic server RPCs
   (row locks, idempotency `operation_id`, WAC recomputed, stock ≥ 0, history kept by status, never hard-deleted).
   No direct table writes on financial columns; no duplicate shift transactions written from the client.
4. **Offline-first:** every online write path needs its queue/replay path (`sync-queue.ts`, client UUID); optimistic
   UI; never block checkout on the network; POS sales via `pos-sale-atomic.ts` + `transaction-lock.ts`.
5. **Never auto-wipe local data:** no `indexedDB.deleteDatabase`, `localStorage.clear()` or bulk key removal outside a
   deliberate, confirmed manual action in Settings/Data Management.
6. **Platform guards:** wrap every `@capacitor/*` call in `Capacitor.isNativePlatform()` (dynamic import, no static
   native imports in shared code); Electron-only code behind the desktop check; printing via `native-print.ts`,
   never `window.print()` on mobile; thermal printing = ESC/POS (`lib/printer/`).
7. **Notifications:** in-app only via `showSmartToast`; never `sendLocalNotification` for routine business events.
8. **Security:** no hardcoded keys/passwords; never commit `.env`, keystores or signing secrets; keep tenant/RLS
   isolation; Supabase client uses `brokeredPreviewStorage()`; never disable auth/TLS/sandboxing.
9. **UI lock:** never rename/re-translate established button labels or checkout order; `i18n` may only gain keys;
   Arabic RTL, UTF-8 without BOM, never introduce mojibake. Redesign only when asked (see `docs/ui-standards.md`).
10. **Licenses/users:** never delete a user, account or data when suspending; keep re-activation available; confirm
    before suspending trial/active licenses; never touch permanent/admin accounts.
11. **Database:** no SQL, RPC, migration or schema change without showing it and getting explicit owner approval;
    never edit existing files in `supabase/migrations/`; never run SQL against the live DB on your own.

## Workflow
- Surgical edits only: targeted replacements, never rewrite a whole file for a few lines; preserve comments, Arabic
  text, `console.error`/`logActivity` logging; no unrelated refactors. Out-of-scope findings → one line "Observed, not changed".
- Verify before finishing: `npm run build` exit 0, typecheck adds no errors, `npm run maps:check`. One correction
  attempt; if still failing, revert the change and report precisely. Never claim a check/commit/push that did not happen.
- Git: commit/push only when the owner asks; never push to `main`, merge, or open a PR unless explicitly told; never
  `push --force`, `reset --hard`, `clean -fd` or `--no-verify` unless the owner asks for that exact command.
  **Branch words (apply to every agent/model):** "push" / "on a side, other or another branch" (فرع جانبي/آخر/ثاني) =
  a side branch YOU choose — reuse the branch already in use for this work (the session's designated one) instead of
  creating a new branch for every push; only if none exists, create `ai/<topic>`. Never `main`. "main" / "the
  primary" (المين/الرئيسي/الأساسي) = `main`, and only then. If unsure which one was meant, ask.
- Ask only when a wrong guess risks data loss, a money error, a frozen module or the production DB; otherwise take the
  most conservative reading, say which in one line, and continue.
- Final report in Arabic: summary · files changed · files intentionally untouched · new behaviour · verification
  (build/typecheck/maps) · branch+commit · notes.

## Read on demand only (never by default)
`docs/ISSUES_TRACKER.md` = the single current list of open/closed issues (update it when an issue opens or closes) · `docs/ui-standards.md` · `docs/design.md` · `docs/speed-rules.md` · `FINANCIAL_FORMULAS_AR.md` (examples only; the law is mandatory, see above)
· `docs/lessons-learned.md` (before touching a previously broken area) · `docs/PROJECT_NOTES.md` (offline queue, release
control, Telegram, DB snapshot) · `SYSTEM_ARCHITECTURE.md` (roles and financial-operations map) · `docs/adr/` ·
`ELECTRON_BUILD.md` · `GRADLE_TROUBLESHOOTING.md`.
**Never read:** `node_modules`, `dist`, `android/**/build`, lock files, `supabase/data-fixes`, `docs/archive`.
`supabase/live-snapshots/` holds only `ROLLBACK_*.sql` scripts: open one only when rolling back the migration whose header names it.
