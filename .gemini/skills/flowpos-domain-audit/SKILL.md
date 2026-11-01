---
name: flowpos-domain-audit
description: Domain invariants and pre-commit audit for FlowPOS Pro. Defines the immutable accounting, offline-first, frozen-module, platform, security, notification, printing, and UI-consistency rules, plus the audit checklist that must pass before any commit. Use for every change that touches storage, sync, money, platform bridges, SQL, notifications, printing, or visible UI text.
version: 2.0.0
---

# FlowPOS Pro — Domain Invariants and Pre-Commit Audit

## 1. Purpose

FlowPOS Pro is an offline-first point-of-sale and accounting system. A single careless change can cause financial errors, lost sales, duplicated invoices, or data loss on a cashier's device. This skill lists the rules that cannot be broken and the audit that proves a change respects them.

## 2. The eight immutable invariants

### Invariant 1 — USD base accounting

- `USD` is the immutable accounting base. Product costs, ledger balances, profits, partner distributions, debts, and cash-shift totals are stored and calculated in USD.
- Other currencies are display and collection currencies. They are converted with a rate, either live or saved in the invoice's currency snapshot (`CurrencySnapshot`).
- Never change the base currency. Never store a non-USD value as the accounting truth.
- Never hardcode `$` or any currency symbol. Resolve symbols dynamically through `resolveInvoiceCurrencySymbol` or `formatCurrency(amount, currencyCode)`.
- Historical invoices keep their saved exchange rate and symbol even when current rates change.

### Invariant 2 — Frozen modules (red line)

The following files are frozen and must never be read for auditing, modified, deleted, or renamed unless the owner explicitly asks to re-enable them:

- `src/pages/Warehouses.tsx`
- `src/pages/StockTransfer.tsx`
- `src/lib/cloud/warehouses-cloud.ts`

Warehouse and custody features are disabled. Routes redirect and menu entries are commented out. `src/hooks/use-warehouse.tsx` remains active because point-of-sale flows depend on its default warehouse read-only fallback, so it may be used but its behavior must be preserved.

### Invariant 3 — In-app notifications only

- Every routine business notification (sales, debt sales, refunds, settings saves, stock alerts) renders in-app through the Dynamic Island `SmartToast` (`showSmartToast`).
- Never call `sendLocalNotification` for routine financial events. Android system notification shades must not receive routine sales notices.
- Notifications are reserved for real state changes (for example, "Invoice saved successfully" or "Error adding expense"). Do not add decorative toasts such as "Tab switched".

### Invariant 4 — Thermal and native printing

- Printing must support thermal receipt printers (ESC/POS 80 mm and 58 mm, Bluetooth, network, USB) and canvas-to-image sharing.
- Route all printing through `src/lib/native-print.ts`.
- Never call `window.print()` on Capacitor mobile builds or inside mobile WebViews.

### Invariant 5 — Offline sync and mutex protocol

- Every checkout operation must acquire `transaction-lock.ts` to prevent double-tap duplicates.
- Every offline write must update optimistic local state immediately and enqueue a typed payload in `sync-queue.ts` with a unique idempotency key (UUID).
- Use the established fallbacks (for example `saveToLocalAndQueue`). A network failure must never result in data loss.
- Never block checkout on a network promise.
- Sales pass through the atomic sale path (`pos-sale-atomic.ts`).
- Cancellation checks (`isOperationCancelled` and the cancellation registry) must be preserved.

### Invariant 6 — No automated production SQL

- No agent may execute, apply, or recommend executing migrations, DDL, or DML against the live Supabase database.
- Before proposing any SQL, inspect the existing schema (`supabase/migrations/` and the generated types file), analyze dependencies, lock contention, and row-level-security impact, then present the script as an artifact for explicit approval.
- Only an explicit, unequivocal owner confirmation permits execution, and the owner runs or approves it.

### Invariant 7 — Zero automatic wiping of local data

- Code must never execute `indexedDB.deleteDatabase('hyperpos_cache')`, `localStorage.clear()`, or bulk key removal without a deliberate manual action.
- Any reset must come from a dedicated button in Settings or Data Management, behind a confirmation modal with clear warnings.
- The reason: unsynced invoices, debt payments, and mutation queues exist only on the device until synchronization completes.

### Invariant 8 — UI Consistency Lock

- Established button labels, action text, and checkout button positions are locked. Examples include "فاتورة نقدية", "بيع آجل", "طباعة", "مشاركة", "إلغاء", "تسجيل دفعة", and "حفظ".
- Translation dictionaries (`i18n.ts`) may only gain new keys. Never overwrite an established key without an explicit owner request.

## 3. Platform and security rules

- Capacitor: every call to `@capacitor/*` (Camera, Barcode, Filesystem, Share, and others) must sit behind `Capacitor.isNativePlatform()` or fall back to a web alternative. Do not statically import native plugins into code that runs on the web without a guard or dynamic loading.
- Electron: desktop-only logic must be guarded by `getPlatformStoragePrefix() === 'desktop'`.
- Supabase clients must use `brokeredPreviewStorage()` so preview windows do not clobber each other's sessions.
- Row-level security: no query may bypass store or user multi-tenancy.
- Credentials: no hardcoded API keys, tokens, or passwords. Never commit `.env` files with real values, keystores (`.keystore`, `.jks`), or signing secrets.
- Input validation: validate all external input. No SQL or command injection paths.
- Do not disable authentication, TLS, or sandboxing for convenience.
- Licensing: never delete a user, account, or records when a license is suspended. Keep the reactivation path available. Verify license type before any action and ask for confirmation before suspending trial or paid licenses.

## 4. Encoding and text rules

- All Arabic strings are UTF-8 without BOM and must be readable. Any mojibake sequence is a critical failure.
- Use `dir="rtl"` layouts for Arabic content and keep monospace financial digits where the design requires them.

## 5. Pre-commit audit checklist

Run this checklist for every change before committing. Mark each item pass, fail, or not applicable, and explain every fail.

1. **Scope:** `git status` lists only files that the request required. No frozen module appears in the list.
2. **Offline and sync:** every new or changed write path is enqueued through the sync queue with an idempotency key, and the optimistic UI updates immediately.
3. **Financial:** every changed money value is stored and calculated in USD; no `$` literal was introduced; rounding respects the currency decimals; the formula change, if any, was explicitly requested.
4. **Platform guards:** every native or Electron call has its guard; no native plugin is statically imported into web-only paths.
5. **Notifications:** no `sendLocalNotification` call was added for routine events.
6. **Printing:** no direct `window.print()` call was added on mobile paths.
7. **Locks:** checkout paths still acquire `transaction-lock.ts`.
8. **Data safety:** no code path clears IndexedDB, localStorage, or sync queues automatically.
9. **SQL:** no SQL, RPC, migration, or RLS change was executed; any proposal is shown and approved.
10. **Labels:** no established button label or checkout order changed.
11. **Logging:** existing `console.error`, `logActivity`, and `errorRadar` calls are intact.
12. **Encoding:** Arabic text is readable and UTF-8.
13. **Build:** `npm run build` exited with code 0.

## 6. Audit verdict format (Arabic)

- Verdict: "مقبول" when every item passes or is not applicable; "مرفوض" when any item fails.
- For a rejected change, list each failed item with the file and line, and do not commit until it is fixed.
- For an accepted change, list only the items that were relevant to the change.

## 7. Escalation

If a requested change would break an invariant, stop that part, explain the invariant in one Arabic sentence, and propose a compliant alternative. Do not proceed on the basis of "it is probably fine".
