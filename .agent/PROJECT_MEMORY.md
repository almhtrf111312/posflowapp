# 🧠 FlowPOS Pro — Persistent Project Memory (Project State & Ledger)

**Last Updated:** 2026-11-08
**Current Version:** `v1.5.74 (Build 462)`
**Repository Branch:** `main`
**Base Accounting Currency:** `USD`  
**Primary Language / Direction:** Arabic (`ar`) RTL (with EN/TR support)

---

## 🏛️ System Architecture Summary
* **Frontend:** React 18, Vite 7 (SWC), Tailwind CSS, Radix UI primitives.
* **Platforms:**
  * **Web (PWA):** Vite PWA (`vite-plugin-pwa`) with Workbox service worker caching.
  * **Mobile:** Capacitor 8.1 (Android ID: `com.flowpos.pro`, plugins: MLKit barcode scanner, camera, filesystem, share).
  * **Desktop:** Electron (`electron/main.js` + `electron-builder` portable Windows bundle).
* **Storage & Data Layer:**
  * **Local DB:** IndexedDB (`hyperpos_cache` v2 for products, barcode lookup indices, pending stock deductions).
  * **Secure Local Storage:** Encrypted via device keys (`secure-storage.ts`, `safe-storage.ts`).
  * **Offline Sync Engine:** FIFO Queue (`sync-queue.ts`), 25+ atomic operation types (`sale`, `debt_sale_bundle`, `invoice_refund`, etc.), idempotency tracking, collision detection (`cancellation-registry.ts`), and mutex locking (`transaction-lock.ts`).
  * **Cloud Backend:** Supabase (PostgreSQL 15+ with RLS, atomic RPCs e.g., `process_pos_sale_atomic`, Realtime subscriptions).

---

## 🔒 The 8 Immutable Invariants
1. **USD Accounting Invariant:** USD is the system's immutable calculation base. All profits, partner distributions, debts, and ledger items are pegged to USD. Foreign currencies are calculated via real-time/saved exchange rates.
2. **Frozen Modules (DO NOT TOUCH):**
   * `src/pages/Warehouses.tsx`
   * `src/pages/StockTransfer.tsx`
   * `src/lib/cloud/warehouses-cloud.ts`
   *(Per project directive, warehouse transfers and custody are frozen to protect cloud credits).*
3. **In-App Notification Rule:** All notifications must render in-app through the Dynamic Island `SmartToast` (`showSmartToast`). Android system notifications (`sendLocalNotification`) are suppressed for daily retail sales to prevent blank/delayed notifications.
4. **SQL Safety & Schema Guard:** Automated or unilateral execution of SQL migrations/RPCs against production Supabase is strictly banned. Schema inspection and explicit user approval are mandatory.
5. **Anti-Data-Loss (Local Storage Guard):** Zero programmatic wiping of `IndexedDB` (`hyperpos_cache`) or `localStorage`. Resets require physical user button click with a confirmation modal to protect unsynced offline invoices.
6. **UI Consistency Lock (UCL):** Established cashier button names and labels (e.g., "فاتورة نقدية", "طباعة", "سداد") are locked to prevent disruption of cashier muscle memory.
7. **Thermal Printing Protocol:** Must support thermal receipt printers (ESC/POS 80mm/58mm, Bluetooth, USB) and Canvas-to-Image sharing via `src/lib/native-print.ts`. Never use raw `window.print()` in mobile WebViews.
8. **Offline Mutex Lock Protocol:** POS checkout must acquire `transaction-lock.ts` to prevent duplicate submissions on cashier double-taps.

---

## 🛠️ Repository Skills Matrix & Standby Catalog

### 1. Active Autonomous FlowPOS Core Skills (`.agent/skills/` & `.gemini/skills/`)
* **`flowpos-core-workflow`:** Complete execution protocol: spec planning, commits, multi-turn communication, Arabized reporting, and quality gates.
* **`flowpos-surgical-editing`:** Token efficiency protocol: symbol/range-level reading, small contiguous diffs with text anchors, and zero-leakage editing.
* **`flowpos-structure-symbol-map`:** Large-file structure and symbol mapping, Mermaid architectures, numeric auditing, backed by `flowpos_map.py`.
* **`flowpos-domain-audit`:** Domain integrity auditor checking offline sync, USD accounting invariants, frozen modules, and schema safety.
* **`flowpos-financial-calculations`:** Unified reference for accounting, taxes, rounding, multi-currency conversion, and debt allocations (`references/FINANCIAL_FORMULAS_AR_ORIGINAL.md`).
* **`flowpos-release-github-memory`:** Release governance, automated memory updates, ADR synchronization, and git delivery.
* **`flowpos-ui-ux-pro-max`:** Pro Max design intelligence engine: style/motion/typography search, tactile Arabic RTL POS guidelines, and pre-delivery checklist.

### 2. Auxiliary Standby Design Skills (`.agents/skills/`)
*(Kept dormant / on standby; available to borrow rules if specialized creative tasks arise)*:
* `brandkit`: Brand guidelines and logo system generation.
* `design-taste-frontend` & `design-taste-frontend-v1`: Web landing and layout aesthetics.
* `full-output-enforcement`: Anti-truncation enforcement for legacy LLMs.
* `gpt-taste`: GSAP motion and creative layout variance.
* `high-end-visual-design`: Agency-style spacing, shadows, and card structures.
* `image-to-code`: Generates code from UI mockups.
* `imagegen-frontend-mobile` & `imagegen-frontend-web`: Conceptual visual image prompts.
* `industrial-brutalist-ui`: Mechanical, high-density terminal layouts.
* `minimalist-ui`: Editorial monochrome layouts.
* `redesign-existing-projects`: Generic AI UI cleanup auditor.
* `stitch-design-taste`: Google Stitch design system generator.

---

## 🕒 Recent Implementations & Changelog Log
* **2026-11-08:** Release v1.5.69 (Build 457) — POS Mobile 3-Column Grid Fix & Comprehensive Reports Audit (EGM Implementation):
  * EGM Design Specification & Review Swarm (`docs/designs/pos-grid-and-reports-audit.md`, `docs/designs/consolidated_review_report.md`): Formulated comprehensive specification and conducted 7-persona Goldfish review swarm (`design`, `codebase-details`, `implementation-readiness`, `inventive-catalyst`, `zoom-out`, `structural`, `comprehension`) resolving layout real estate math and calendar date boundaries.
  * POS Mobile 3-Column Grid Optimization (`src/components/pos/ProductGrid.tsx`): Dropped `xs: 380px` constraint, enabling 3 items side-by-side (`grid-cols-3 sm:grid-cols-4...`) directly on all mobile devices (320px–375px); applied TRIZ extraction pattern by floating the quantity badge (`absolute top-1 end-1 z-10`) over the 4:3 product image, freeing 100% of the card base exclusively for full price rendering (`text-[11px] sm:text-xs font-black`) without truncation, and providing 2 lines for titles (`line-clamp-2 min-h-[1.75rem]`).
  * Unified Local Date Engine (`src/lib/date-utils.ts`): Enforced regex guard `/^\d{4}-\d{2}-\d{2}$/` against ECMAScript UTC midnight parsing shifts in negative timezones; eliminated fixed 86,400,000ms subtraction with calendar-based `d.setDate(d.getDate() - n)` preventing DST anomalies; centralized UI date presets via `getDatePresetRange(preset)`; introduced `getLocalDayUtcRange(dateStr)` bridging browser local day boundaries (`00:00:00.000` to `23:59:59.999`) to UTC ISO for database queries; and implemented lexical range checks in `isDateInRange`.
  * Central Financial Invoice Status Validation (`src/lib/cloud/invoices-cloud.ts`): Exported canonical domain predicate `isValidActiveInvoice(inv)` strictly excluding cancelled, refunded, and written off records.
  * Comprehensive Reports Status & Timezone Isolation: Applied `isValidActiveInvoice` and local date normalization across `src/pages/Reports.tsx`, `ReportFiltersBar.tsx`, `SalesDetailedReport.tsx`, `CashierPerformanceReport.tsx`, `MaintenanceReport.tsx`, `DailyClosingReport.tsx`, `PartnerProfitDetailedReport.tsx`, `LibraryReport.tsx`, and `DebtsReport.tsx`.
  * Cloud & Offline Debt Payments Resilience (`src/lib/cloud/debts-cloud.ts`): Bridged Supabase queries with `getLocalDayUtcRange(dateStr)` and fortified offline activity log filtering with `toLocalDateString(l.timestamp) === dateStr`.
  * Invariants Guard: 100% frozen modules (`Warehouses.tsx`, `StockTransfer.tsx`, `warehouses-cloud.ts`) untouched, USD base preserved, zero hard deletes, touch targets >= 44px, and verified build gate (`npm run build = 0` in 20.73s).
* **2026-11-08:** Release v1.5.68 (Build 456) — Comprehensive Mobile Responsive UI/UX, Typography Scaling & Touch Targets Hardening (EGM Audit):
  * EGM Design Specification & Review Swarm (`docs/designs/mobile-responsive-ui-ux-audit.md`, `docs/designs/consolidated_review_report.md`): Formulated comprehensive 11-section mobile responsive specification and executed 7-persona Goldfish review swarm auditing viewports, typography scaling, touch ergonomics, and WCAG AA contrast.
  * Zero Financial Truncation Enforced (`src/components/pos/ProductGrid.tsx`): Completely removed `truncate` and `min-w-0` on financial price spans, enforcing full amount visibility with non-truncating tabular numbers across all catalog views.
  * Touch Targets Upgrade (>= 44px × 44px): Upgraded quantity increment/decrement steppers (`CartPanel.tsx`) with invisible touch expansion (`after:absolute after:-inset-1.5`), enlarged item delete buttons (`size-9`), unit switch triggers, calculator button, mobile header menu and cart buttons (`w-11 h-11`), and isolated invoice three-dots menu with expanded row padding (`pl-12`).
  * Viewport & Safe Area Optimization (`src/pages/POS.tsx`, `src/components/pos/POSHeader.tsx`, `src/components/pos/CartPanel.tsx`, `src/components/layout/Sidebar.tsx`): Upgraded mobile cart sheet to `h-[90dvh]` with safe-area insets, enforced bottom safe padding (`pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.5rem))]`) on cart checkout footer preventing interference with Android gesture navigation pill, and resolved header safe-area sizing.
  * Responsive Grid & Tabs Decoupling (`src/components/pos/ProductGrid.tsx`, `src/components/ui/SegmentedCapsule.tsx`): Introduced `xs: "380px"` breakpoint in `tailwind.config.ts` for dense view (`grid-cols-2 xs:grid-cols-3`), decoupled horizontal scrolling tabs (`capsuleScrollItem`) with standard PostCSS scrollbar suppression preventing vertical text column collapse.
  * WCAG AA Adaptive Contrast & Hardcoded Color Purging (`src/hooks/use-theme.tsx`, `src/components/pos/ProductGrid.tsx`, `src/components/pos/POSHeader.tsx`): Added adaptive `--primary-foreground` contrast for high-luminance light themes (lime, coffee, orange) and replaced hardcoded hex colors with native Tailwind tokens.
  * Invariants Guard: 100% frozen modules (`Warehouses.tsx`, `StockTransfer.tsx`, `warehouses-cloud.ts`) left untouched, cashier muscle memory strictly locked, and zero accounting changes.
* **2026-11-08:** Release v1.5.67 (Build 455) — Comprehensive Security & Financial Logic Hardening (EGM Audit Remediation):
  * EGM Design Specification & Review Swarm (docs/designs/security-and-financial-audit.md, docs/designs/consolidated_review_report.md): Completed exhaustive 11-section specification and conducted 7-persona Goldfish review swarm verifying zero-compromise security and accounting integrity.
  * Fail-Closed Security Lock Guard (src/hooks/use-app-lock.tsx): Eliminated critical Fail-Open bypass vulnerability where missing or cleared local salt/hash allowed instant unlock; enforced strict Fail-Closed lock retention, Web Crypto SHA-256 with 16-byte random salt, and removed insecure 32-bit string hash fallback.
  * Mutex Double-Click Rejection (src/lib/transaction-lock.ts & src/components/pos/CartPanel.tsx): Added non-blocking 	ryAcquireLock and integrated it into confirmCashSale and confirmDebtSale with guaranteed inally release, actively rejecting fast double-tap duplicate invoice submissions instead of queuing.
  * In-Memory Cashier Cost Price Sanitization (src/lib/cloud/products-cloud.ts): Implemented sanitizeProductForCashier and sanitizeProductsForCashier in-memory scrubbers to protect profit margin confidentiality without writing zero costs to IndexedDB or corrupting cloud sync.
  * Sync Queue Parent-Child Dependency Tracking (src/lib/sync-queue.ts): Added dependsOn tracking and skip logic in processQueue to prevent child operations (e.g., debt settlement) from failing with terminal errors before parent bundle completion.
  * Zero Accounting Invariant Regressions: 100% tax exclusion preserved, USD base maintained, zero hard deletes, and frozen warehouse modules left untouched.
* **2026-11-08:** EGM Stage 1 Architecture Design PR — Ultra Performance Audit & Hardware-Accelerated Tab Transitions:
  * EGM Design Specification (`docs/designs/performance-and-tab-transitions.md`, `docs/designs/README.md`): Completed comprehensive architectural specification for 60 FPS hardware-accelerated tab slide transitions (240ms, `cubic-bezier(0.2, 0.9, 0.3, 1.0)`) across all device brands, themes, and RTL/LTR directions.
  * EGM Goldfish Review Protocol (`consolidated_review_report.md`): Orchestrated multi-persona review across 7 autonomous goldfish subagents (`zoom-out`, `inventive-catalyst`, `comprehension`, `design`, `structural`, `implementation-readiness`, `codebase-details`).
  * Hardened Architectural Decisions: Corrected `TAB_ORDER` to exclusively target the 9 internal `NativeTabHost` tabs, decoupled full-screen POS routes, corrected storage I/O deferral to use `transitionend` + `requestIdleCallback`, and targeted pinpoint component extractions in `ProductGrid.tsx` and `CartPanel.tsx` with zero modifications to accounting formulas.
* **2026-11-08:** Release v1.5.66 (Build 454) — App Security Lock Enforcement & Theme Transition Dynamics (EGM Spec-Driven Implementation):
  * Security Lock Subsystem (`src/hooks/use-app-lock.tsx`, `src/components/auth/AppLockOverlay.tsx`, `src/App.tsx`): Introduced `AppLockProvider` and `useAppLock` consuming `useAppLifecycle` without modifying generic infrastructure; enforced synchronous initial lock on cold start and timeout checks on resume; non-destructive fullscreen modal with `role="dialog"`, `data-state="open"`, and background DOM isolation via HTML5 `inert`; tactile numpad with explicit confirm button supporting 4-8 digit PINs; persistent lockout rate-limiting (30s after 5 errors); emergency sign-out modal; Android hardware back-button trap via `CapApp.exitApp()`.
  * Whitelisting & Auth Safety (`src/hooks/use-auth.tsx`): Whitelisted `flowpos_app_lock_*` in `clearAllUserSessionCaches` preventing erasure of lock state and hash upon sign-in/out.
  * Security Settings (`src/components/settings/ProfileManagement.tsx`): Added security lock toggle, timeout selector (immediate, 1m, 5m), and local client-side salted SHA-256 derivation coupled with cloud `set_user_pin`.
  * Theme Dynamics Calibration (`src/lib/theme-transition.ts`): Calibrated view-transition circular expansion to 550ms with Xiaomi HyperOS physics curve `cubic-bezier(0.2, 0.9, 0.3, 1.0)`.
  * EGM Spec & Review Deliverables (`docs/designs/security-lock-and-theme-animation.md`, `consolidated_review_report.md`): Checked-in fully approved EGM technical design specification and comprehensive goldfish review report.
* **2026-11-05:** Release v1.5.48 — Password/PIN Hashing, Phone Normalization, Unique Guard & Pre-Check:
  * Backend SQL Migration (`supabase/migrations/20261105210000_password_pin_hashing_and_phone_normalization.sql`): Added `pgcrypto` bcrypt cost 10 support, `pin_hash` column to profiles, atomic `set_user_pin` and timing-safe `verify_user_pin`, `normalize_phone_number` with Syria/Turkey/international formats, automatic normalization trigger, partial unique index `idx_profiles_phone_unique`, and proactive `check_phone_email_availability` RPC.
  * Edge Function Protection (`supabase/functions/create-user/index.ts`): Added pre-check validation for phone and email uniqueness preventing silent takeover or duplicate registrations, with informative Arabic errors.
  * Front-End Normalization & Pre-Check (`src/lib/phone-utils.ts`, `src/hooks/use-users-management.tsx`, `src/components/settings/UsersTab.tsx`): Centralized phone normalization utility; wired `check_phone_email_availability` into `addUser` and `updateUserProfile`; enabled phone editing for existing users.
  * Profile Self-Management & Quick PIN (`src/components/settings/ProfileManagement.tsx`): Added phone management with uniqueness validation and Quick Cashier PIN setup/update modal using `set_user_pin`.
* **2026-11-05:** Release v1.5.47 — Support Route & Blocked Account Flow (Stages 1-4):
  * Public Route Rollout (`src/App.tsx`): Registered `/contact-developer` outside `ProtectedRoute` to resolve 404 and unauthorized redirect loops for non-logged-in users.
  * Blocked Account Redirect (`src/hooks/use-auth.tsx` & `src/pages/Login.tsx`): Enhanced `signIn` to return explicit `blockedReason` (`inactive`, `owner_inactive`, `revoked`); automatically redirects blocked users to `/contact-developer` with context instead of leaving them stuck on login screen.
  * Activation Screen Support Access (`src/components/license/ActivationScreen.tsx`): Updated license activation screen to route directly to `/contact-developer` with `supportReason` (`expired` or `activation_required`) and user email.
  * Dynamic Support Context Banner (`src/pages/ContactDeveloper.tsx`): Added top alert card rendering tailored Arabic guidance and associated user email based on `supportReason` with a back button to login.
* **2026-11-04:** Release v1.5.39 (Build 427) — Task 3: Cash Shifts, Debt Payments, Shift Transactions & Proportional Profit:
  * Cash Shift Cloud Sync (`src/lib/cloud/cashbox-cloud.ts` & `src/lib/cloud/sync-operation-processor.ts`): Resolved root cause of 0 cloud shifts by enforcing `opened_at` timestamp and `user_id: ownerId` on `cash_shifts` insert/upsert; added `cash_shift_upsert` to sync queue operations ensuring shifts and transactions persist safely offline-to-cloud.
  * Debt Payment Shift Linking (`src/pages/Debts.tsx` & `src/lib/cloud/debts-cloud.ts`): Passed active `shift_id` from open cashbox shift to `recordPaymentWithInvoiceSyncCloud`, automatically recording debt payments into active cash shift transactions and updating expected cash balances.
  * Immediate Cache Purge: Purged partner, customer, and cashbox caches upon debt payment.
  * Backend SQL Patch (`supabase/migrations/20261104234500_cash_shifts_and_debt_payments_atomic.sql`): Added `shift_id` column to `debt_payments`, created `shift_tx_ref_uniq` unique index on `shift_transactions`, upgraded `record_debt_payment_atomic` with `_shift_id` parameter and automatic proportional partner profit confirmation, and upgraded `writeoff_debt_atomic` to clear lingering pending partner profits.
  * Verification: `npm run build` passed with exit code 0.
* **2026-11-04:** Release v1.5.38 (Build 426) — Task 2: Partners, Profit Allocation, Expense Sharing & Debt Profit Confirmation:
  * Backend SQL Patch (`supabase/migrations/20261104233000_partners_profit_expense_and_debt_atomic.sql`): Dropped duplicate signatures for `add_expense_atomic` and corrected expense deduction formula to use direct partner percentage (`_amt * (_partner_pct / 100.0)`) preventing 100% inflation; added atomic proportional debt profit confirmation (`confirm_partner_debt_profit_atomic`) transferring pending profit to confirmed balance upon partial debt settlements.
  * Partner Card Currency Standardization (`src/pages/Partners.tsx`): Standardized partner profits and capital to explicit USD with real-time equivalent currency capsules (`getEquivalentCurrencies`), eliminating misleading local currency labels on USD amounts.
  * Explicit Expense Share Persistence (`src/pages/Partners.tsx`): Enforced exact `expenseSharePercentage: formData.sharesExpenses ? Number(formData.expenseSharePercentage || 0) : 0` in edit partner payload, removing erroneous fallback overriding custom values.
  * Immediate Cache Invalidation (`src/pages/Debts.tsx` & `src/lib/cloud/partners-cloud.ts`): Added immediate `invalidatePartnersCache()` and RPC integration to `confirmPendingProfitCloud` and debt settlement actions.
  * Verification: `npm run build` passed with exit code 0.
* **2026-11-04:** Release v1.5.50 (Build 450) — Supabase Whitelist Update & Central Sale & Profit Engine Local Migration:
  * Front-End Whitelist (`src/lib/supabase-store.ts`): Updated `TABLE_ALLOWED_COLUMNS` for `invoices` (added `tax_inclusive`, `settlement_kind`, `settlement_diff_usd`), `partners` (restored accounting and history fields: `capital`, `current_balance`, `total_profit_earned`, `total_withdrawn`, `expense_share_percentage`, `shares_expenses`, `confirmed_profit`, `pending_profit`, `profit_history`, `withdrawal_history`, `expense_history`, `category_shares`, `is_full_partner`, `joined_at`, `status`), `products` (added `unit`, `supplier`, `location`, `notes`, `description`, `warranty_months`, `serial_number`, `batch_number`, `weight`, `size`, `color`, `fabric_type`, `author`, `publisher`, `table_number`, `order_notes`), and `recurring_expenses` (added `currency`, `original_amount`).
  * Backend SQL Migration (`supabase/migrations/20261104230000_process_pos_sale_atomic_and_profit_recalc.sql`): Synchronized local database schema with the cloud engine: unified 17-parameter `process_pos_sale_atomic` with owner resolution (`get_owner_id`), carton conversion factor stock deduction, idempotency guarantee (`operation_id`), and 8-decimal tax-isolated profit recalculation (`recalc_pos_invoice_profit`).
  * Verification: `npm run build` passed with exit code 0.
* **2026-11-02:** Release v1.5.24 (Build 412) — Large Store Readiness, Financial Immutability & Toast Fixes:
  * Store Settings Crash Fix (`src/pages/Settings.tsx` & `src/components/settings/StoreInfoSection.tsx`): Removed undeclared `logoInputRef` prop which caused a runtime `ReferenceError` when opening store settings tab.
  * Large Store Pagination (`src/lib/supabase-store.ts`): Implemented chunked auto-pagination in `fetchFromSupabase` using `.range(offset, offset + 999)` up to 50,000 rows, preventing silent PostgREST 1000-row cutoff across invoices, products, debts, expenses, and customers.
  * Financial Immutability & Soft Cancellation (`src/lib/cloud/invoices-cloud.ts`): Replaced destructive physical `DELETE` on invoices with soft cancellation (`status: 'cancelled'`) and immediate profit reversal via `reverseProfitCloud`, preserving audit trail and tax compliance.
  * Maintenance COGS & Cash Shift Fix (`src/components/pos/MaintenancePanel.tsx`): Eliminated duplicate expense recording for maintenance parts cost; linked cash maintenance payments directly to active shift transactions and cashbox balance.
  * Fire-and-Forget Profit Sync Fix (`src/pages/Debts.tsx`, `src/pages/Invoices.tsx`, `src/lib/cloud/cash-sale-handler.ts`, `src/lib/cloud/debt-sale-handler.ts`): Added `await` and error logging to `confirmPendingProfitCloud` and `distributeDetailedProfitCloud`.
  * Notification Clipping Fix (`src/lib/sonner-bridge.ts`, `src/components/ui/sonner.tsx`, `src/components/ui/SmartToast.tsx`, `src/index.css`): Separated title from message, expanded card width, removed root `overflow-hidden`, and scoped Xiaomi theme border-radius to icon only to prevent text clipping.
  * Daily Closing Report Accuracy (`src/components/reports/DailyClosingReport.tsx`): Filtered out refunded and cancelled invoices from daily sales and profit calculations.
* **2026-11-02:** Instant Telegram Release Pipeline & Automated Semantic Version Bumping:
  * Fast Telegram Release (`supabase/functions/trigger-public-release/index.ts` & `.github/workflows/telegram-public-release.yml`): Redirected public release trigger from `build-apk.yml` to `telegram-public-release.yml`; workflow fetches pre-built APK artifact from latest build and sends directly to Telegram channel in seconds without costly 15-minute rebuild.
  * Dual Version & Build Bump (`scripts/bump-version.js` & `.github/workflows/auto-version-bump.yml`): Defaulted `bumpType` to 'patch' so both `versionName` (semantic patch, e.g. 1.5.3 -> 1.5.4) and `versionCode` (build number) increment synchronously on every push to main; sanitized legacy 4-part versions into standard semver.
* **2026-11-02:** Instant 0ms Settings Loading & Sale vs Refund Queue Shield:
  * Settings Screen (`src/pages/Settings.tsx`): Initialized `isSettingsReady` to true and eliminated blocking loader spinner in JSX, rendering tabs instantaneously from local cache while cloud sync proceeds quietly in background.
  * Invoices Refund Handler (`src/pages/Invoices.tsx`): Before attempting cloud refund, searches local sync queue for any pending sale operation for the invoice and cancels/removes it immediately; falls back to full local refund with product quantity restoration and queue entry if network/VPN fails.
  * Cloud Sync Safety Shield (`src/providers/CloudSyncProvider.tsx`): Added pre-upload check against local cached invoices to skip uploading sales if invoice is marked refunded or cancelled locally.
  * Cloud Invoices RPC Timeout (`src/lib/cloud/invoices-cloud.ts`): Wrapped `refund_invoice_atomic` with a 3.5s race timeout to prevent app freeze on broken/high-latency VPN connections, triggering instant local-first fallback.
* **2026-11-01:** Telegram Bot Self-Service Device Reset & OTP Password Recovery:
  * Front-End (`src/pages/Login.tsx`): Removed email recovery form; dedicated forgot-password flow exclusively to Telegram Bot OTP verification with real-time numeric/character criteria checklist; prominent developer contact button (/contact-developer).
  * Telegram Auth Edge Function (`supabase/functions/telegram-auth/index.ts`): Configured persistent 2-button keyboard (phone contact sharing & /reset_device); implemented secure device reset handler invoking `request_device_reset_secure` RPC with strict 5-day cooldown enforcement.
  * Skills Bundle v2.0.0: Consolidated 7 core skills in `.agent/skills/` and `.gemini/skills/` with updated memory ledger.
* **2026-11-01:** Skills Bundle v2.0.0 — consolidation and migration:
  * Consolidated legacy disparate skills into 7 unified, production-grade FlowPOS skills under .agent/skills/ and .gemini/skills/: flowpos-core-workflow, flowpos-surgical-editing, flowpos-structure-symbol-map (with flowpos_map.py), flowpos-domain-audit, flowpos-financial-calculations (with full formulas reference), flowpos-release-github-memory, and flowpos-ui-ux-pro-max.
  * Removed legacy skills: .gemini/skills/user-workflow, .agent/skills/antigravity-serena-token-engine, .agent/skills/flowpos-memory-sync, .agent/skills/flowpos-code-auditor, .agent/skills/flowpos-obsidian-sync, .agent/skills/flowpos-spec-planner, and legacy .agent/skills/ui-ux-pro-max.
  * Preserved all core domain invariants, USD base currency, and application version. Verification tools (flowpos_map.py and search.py) tested and fully operational.
* **2026-10-28:** Appearance Draft Tracking and POS Card Readability:
  * Appearance compares all pending theme fields with its saved baseline; ThemeSection emits the full theme draft while existing preview, save, and revert behavior remains unchanged.
  * POS product cards render the currency symbol and amount with a visible divider and emphasize stock counts using theme semantic colors.
  * Refined the stock-count badge to a 12.25px number in a 24.5px-high capsule, slightly larger than adjacent price text while retaining theme colors.
  * No accounting, stored data, database, or sync behavior changes. Production build passes.
* **Phase 6 — Explicit Currency Activation & Display Modes:**
  * USD remains the base currency; non-USD currencies are not enabled from missing flags or exchange-rate metadata alone. Legacy TRY/SYP slots still resolve their stored currency identity, while setup and cash shifts require explicit enablement (or a deliberately selected primary currency).
  * Added per-currency `symbol` / `name` / `both` settings to unified local/cloud settings and the existing offline settings queue. The choice changes presentation only.
  * Applied mode-aware formatting to POS received amounts and USD equivalents, invoice details/refunds/print/share/canvas, cash-shift summaries, report screens, and PDF/Excel currency headers. Removed the redundant POS invoice-currency panel and fixed the received-amount field and total spacing.
  * No accounting, stored amount, historical exchange-rate, SQL/RPC, database, or IndexedDB changes. `npx tsc --noEmit`, `npm run build`, and `git diff --check` pass. No package test script is configured; ESLint still reports existing violations in touched legacy files.
* **Canonical Currency Symbols (Phase 5):**
  * Legacy Arabic currency symbols are displayed as their matching ISO code only when the currency identity is verified; intentional custom symbols and international glyphs remain unchanged.
  * Legacy TRY/SYP storage slots are interpreted from their currency symbol before runtime display, and invoice history keeps its saved exchange rate.
  * Updated currency catalog, settings, setup wizard, POS formatting, cash shifts, invoice currency cards, and the shared invoice symbol resolver used by print/share paths.
  * No automatic localStorage/Supabase migration and no accounting, rate, or amount changes. Focused symbol and POS currency tests and production build pass; TypeScript check remains blocked by the pre-existing `inert` typing error in `Sidebar.tsx`, and ESLint reports pre-existing violations.
* **2026-10-27:** Mobile Dialog, Invoice Actions & Sidebar:
  * Accounted for top and bottom safe areas in global dialog sizing; kept existing global overflow behavior to avoid clipping dialogs that rely on scrolling.
  * Separated invoice print/share/profit actions from the scrollable detail body and kept them in a safe-area-aware footer.
  * Limited bottom-sheet positioning/animations to phone widths and centered those dialogs on larger screens.
  * Added a mobile sidebar close button and made the closed sidebar inert and inaccessible to pointer and assistive-technology interaction.
  * Restored a distinct three-column dense POS layout on phones. No storage, sync, backend, or financial calculation changes.
  * Files: `src/components/ui/dialog.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/pos/ProductGrid.tsx`, `src/pages/Invoices.tsx`, `src/index.css`.
  * Production build and TypeScript check pass; 375px viewport smoke check has no horizontal overflow. ESLint still reports existing issues outside changed lines.
* **2026-10-28:** Invoice Currency Card Deduplication:
  * Invoice currency-equation cards now render only enabled currencies and suppress duplicate codes, symbols, and names, including legacy metadata aliases for the Qatari riyal.
  * Qatar currency aliases display the canonical `ر.ق` symbol and `الريال القطري` name while retaining the invoice's saved exchange rate when applicable.
  * Production build passes. No storage, sync, or backend changes.
* **2026-10-27:** POS Mobile Product Grid:
  * Changed the standard POS grid to two columns and later restored the dense POS mode to three columns on narrow screens, retaining responsive counts at larger breakpoints.
  * Expanded product imagery to square card areas and moved quantity badges below the image into the product details, improving product-name and price readability.
  * Production build passes. Targeted ESLint reports one pre-existing empty catch block at `ProductGrid.tsx:154`; no storage, sync, or backend changes.
* **2026-10-27:** Invoice Profit UI Privacy Polish:
  * Removed the per-invoice profit amount from every invoice list card, including admin/boss views; invoice profit remains available only through the protected analysis dialog.
  * Added RTL-safe end padding to the profit dialog header and replaced the raw currency-code exchange-rate suffix with the invoice's display symbol.
  * Rechecked customer print and share paths; no profit or cost is included in printable invoice content or `InvoiceShareData`.
  * Production build and focused profit/financial-precision tests pass. No storage, sync, or backend changes.
* **2026-10-27 (`4dcff8e1`):** Invoice Profit Privacy & Owner/Admin Analysis:
  * Removed profit and maintenance parts cost from the customer-facing invoice details and standard invoice printout. Invoice sharing text/image paths contain no profit or cost fields.
  * Restricted invoice profit KPIs, card-level profit figures, and the standalone invoice profit dialog to `boss` and `admin`; the dialog also checks the role before rendering.
  * Added USD-based profit metrics, historical invoice-currency formatting, product/parts cost, net sales margin, and collected-versus-pending debt profit.
  * Added four focused calculation tests. No storage, sync, Supabase schema, or RPC changes.
* **2026-10-26 (v1.1.9 - Build 339 | Commit `a4c245c`):** Phase 1-6 Full POS & Reports Polish & Unified Export:
  * **POS Cart Currency Selector Isolation & Catalog Fixed Base:** Isolated `ProductGrid` currency display strictly to default store currency (`catalogCurrency`). Added elegant currency capsule buttons in `CartPanel.tsx` header for instant cart receipt currency selection and live total recalculation while preserving catalog prices.
  * **Reports Header Streamlining:** Merged financial reports title directly with Smart/Professional display mode capsule switcher on the same flex row (`whitespace-nowrap shrink-0`) to prevent wrapping and wasted space on mobile viewports.
  * **Unified Dynamic Report Currency & Export:** Converted `PartnerProfitDetailedReport.tsx` to `formatReportAmount` and `roundForCurrency`. Upgraded both `src/lib/excel-export.ts` and `src/lib/pdf-export.ts` to retrieve `getReportCurrency()` and convert all accounting numbers across sales, invoices, expenses, partners, cash shifts, and custody reports into active report currency with formal headers.
  * **Non-Scrolling Categorized Tab Matrix:** Eliminated horizontal scrolling (`overflow-x-auto`) for report categories. Organized all reports into vertical sections with responsive grids (`grid-cols-2 sm:grid-cols-3 md:grid-cols-4`) for sales, inventory, debts, and admin operations.
  * **ProfitTrendChart Deduplication:** Stripped duplicate top summary stats cards appearing above average daily profit line; expanded clean chart height to 280px with neat footer KPI highlights.
  * **Production Build & Verification:** Zero TypeScript errors, 11/11 automated unit tests passed, production build passed in 12s, committed and pushed to `origin main` and `origin event-or-artifact`.
* **2026-10-26 (v1.1.8 - Build 338 | Commit `25002e9`):** Line-Level Price Entry Currency Scope in POS:
  * Isolated invoice currency (governed by store settings) from cart item price entry currency.
  * Added line-level currency dropdown adjacent to `EditablePrice` in `CartPanel.tsx` storing `item.priceEntryCurrencyCode` and `item.priceEntryRateSnapshot`.
  * Updated held-cart management (`HeldCart`) to store and restore `invoiceCurrencyCode` and `invoiceExchangeRateSnapshot`.
  * Added comprehensive test suite `pos-currency-scope.test.ts` (5/5 passed).
* **2026-10-26 (v1.1.7 - Build 337 | Commit `64c5022`):** Instant Native-Feel Page Navigation & Keep-Alive Lifecycle:
  * Implemented `PageActivityContext` and Keep-Alive tab system keeping heavy pages in memory with LRU eviction policy.
  * Added progressive batch pagination (20 items/page) with IntersectionObserver for `Products.tsx`.
  * Implemented user-scoped Stale-While-Revalidate caching (`native-swr-cache.ts`).
* **2026-10-26 (v1.1.6 - Build 336 | Commit `e474494`):** Smart & Professional Reports Hub:
  * Introduced dual display modes: Smart (visual KPI cards & charts) and Professional (dense tabular data).
  * Categorized reports into structured pills with single consolidated currency banner.
* **2026-10-26 (v1.1.5 - Build 335 | Commit `c8f5c60` & `ae0f888`):** High-Precision Financial Math Engine:
  * 8-decimal intermediate USD precision engine (`money-engine.ts`) preventing rounding drift across QAR, KWD, SYP, TRY, and USD.
  * Dynamic currency decimals (0, 2, 3) and unified cash shifts accounting with automated tests (`financial-precision.test.ts`).
* **2026-11-05 (Tasks 7 & 8 - Debt Profit Release, Period Closures & Tax/Reporting Guard):**
  * **Plan 7 (Debt Payment Atomic Linking & Proportional Partner Profit Release):**
    * Created `supabase/migrations/20261105000000_debt_payment_partner_profit_and_accounting_closures.sql`.
    * Merged proportional partner profit confirmation directly into `record_debt_payment_atomic`: locks partners `FOR UPDATE`, computes payment ratio (`amount / total_debt`), moves confirmed profit from `pending_profit` to `confirmed_profit` and `current_balance`, and maintains partial balance in `pending_profit_details`.
    * Linked payments directly to active `shift_id`, inserting into `shift_transactions` with conflict guards and incrementing `cash_shifts.expected_balance`.
    * Updated `debts-cloud.ts` to trigger `invalidatePartnersCache()` and emit `PARTNERS_UPDATED` on every debt payment.
  * **Plan 8 (Accounting Period Closures & Reporting Guard):**
    * Created `accounting_period_closures` table with RLS store isolation policies.
    * Implemented `close_accounting_period_atomic(_period_start, _period_end)` RPC generating tamper-proof historical snapshots of revenue, COGS, gross/net profits, and partner distributions.
    * Added `accounting_period_closures` to `TABLE_ALLOWED_COLUMNS` in `supabase-store.ts` and `types.ts`.
    * Updated `Reports.tsx` filters to exclude `written_off` invoices from sales and profit totals, preserving the invariant that taxes and written-off debts are never counted as profit.
* **2026-11-04 (Tasks 6 & 7 - Store Isolation, RLS Hardening & Atomic Debt Write-off):**
  * **Plan 6 (Store Isolation, Cashier Sandboxing & RLS Policies):**
    * Created `supabase/migrations/20261104235500_store_isolation_and_debt_writeoff_atomic.sql`.
    * Upgraded `get_owner_id(_user_id)` to reliably resolve owner for cashiers/distributors while keeping admins/boss as their own owners.
    * Hardened RLS policies across `products`, `invoices`, and `debts` using `user_id = public.get_owner_id(auth.uid())`.
    * Isolated `partners` table via RLS: strictly viewable and manageable by admin/boss (`has_role(..., 'admin') OR is_boss(...)`), hiding margins and partner capital from cashiers.
    * Updated frontend `getOwnerIdForInsert()` in `supabase-store.ts`, `expenses-cloud.ts`, and `sync-operation-processor.ts` to guarantee all inserts by staff attach to the store's `owner_id` instead of the cashier's raw UID.
    * Enforced cashier guard in `loadPartnersCloud()` returning empty sets to eliminate RLS permission errors.
  * **Plan 7 (Cashbox, Shifts, Debt Write-off & Idempotent Accounting):**
    * Implemented atomic RPC `writeoff_debt_atomic(_debt_id, _reason, _operation_id)` on PostgreSQL with idempotency checks.
    * Automatically marks debt and associated invoice as `written_off`, deducts remaining debt from customer `total_debt`, and purges/recalculates `pending_profit` across all partners.
    * Updated `writeOffDebtCloud` in `debts-cloud.ts` and `sync-operation-processor.ts` to trigger automatic partner cache invalidation upon debt write-off.
* **2026-11-04 (Tasks 4 & 5 - Tasks 4 & 5 Stabilization Initiative):**
  * **Task 4 (Purchases, Inventory & WAC Engine):**
    * Created `supabase/migrations/20261104235000_wac_and_close_shift_atomic.sql` containing `receive_stock_wac` RPC: 8-decimal weighted average cost (WAC) engine, zero-stock division guard, and automatic audit documentation in `stock_movements`.
    * Updated `QuickPurchaseDialog.tsx` to call `receive_stock_wac` atomically on the server before updating metadata/purchase history, with resilient client-side fallback.
  * **Task 5 (Shifts, Cashbox Close, Variance Reconciliation & Partner Invalidation):**
    * Added multi-currency columns (`currency`, `currency_amount`, `exchange_rate`) to `shift_transactions` in DB and frontend whitelist (`TABLE_ALLOWED_COLUMNS` in `supabase-store.ts`).
    * Expanded `shift_transactions_type_check` constraint to allow `surplus` and `shortage` variance adjustment types.
    * Implemented atomic server-side closing RPC `close_cash_shift_atomic` calculating expected balance and recording auto-reconciliation transactions.
    * Integrated `closeShiftCloud` in `cashbox-cloud.ts` to call `close_cash_shift_atomic` with offline table-fallback.
    * Linked `invalidatePartnersCache()` in `pos-sale-atomic.ts` to immediately sync partner profits and tax exclusions to `Reports.tsx`.
* **2026-10-26 (v1.1.4 - Build 334 | Commit `4958f0f` & `e2516b3`):** Unified Capsule In-Page Tab Navigation:
  * Modern capsule styling across all tabs (`Tabs.tsx`, `BossPanel.tsx`, `Appearance.tsx`, etc.) matching reference product design.
* **2026-10-25 (v1.1.1 - v1.1.3 | Builds 331-333):** Full-Screen Views & Camera Isolation:
  * Full-screen responsive forms for Services (`Services.tsx`) and Purchase Invoices (`PurchaseInvoiceDialog.tsx`).
  * Isolated native camera barcode scanner portal (`NativeCameraPreview.tsx`) preventing inadvertent dialog dismissal or state loss.
  * Instant category synchronization for rapid item creation.
* **2026-10-24 (Branch: `event-or-artifact`):** Phase 2 - In-Memory Money Engine & Compatibility Layer:
  * Created `src/lib/money-engine.ts`: In-memory currency engine with zero-render-blocking localStorage calls, automatic `hyperpos_settings_v1_backup` safety guard, 8-decimal `round8` USD precision, dynamic currency decimal rules (0, 2, 3), and snapshot creation/formatting.
  * Created `src/hooks/use-money.tsx`: React hook powered by `useSyncExternalStore` for reactive currency updates.
  * Created `src/components/ui/MoneyInput.tsx`: `<MoneyInput />` and `<MoneyDisplay />` financial input and display components.
  * Updated `src/types/index.ts`: Expanded `CurrencyCode` to support any standard currency code.
  * Updated `src/lib/currencies.ts` & `src/hooks/use-currency.tsx`: Fixed BHR -> BHD and connected all display and formatting functions to the in-memory engine while preserving 100% backward compatibility.
  * Configured GitHub Actions CI workflows (`build-apk.yml`, `build-windows.yml`) to automatically build and upload APK/EXE testing artifacts for `event-or-artifact`.
* **2026-11-05 (Unified Financial, Storage & Reset SQL Bundle with Exchange Rates):**
  * **Migration `20261105005000_unified_financial_storage_and_reset_bundle.sql`:** Merged full production SQL bundle: `partner_deposit_atomic` with `_exchange_rate`, upgraded `partner_withdrawal_atomic` with `_exchange_rate` and active shift decrement, robust `get_user_storage_stats` for Boss and store owners, and complete hierarchical cascade `reset_user_store_data` with exception safety.
  * **Frontend & Cloud Integration (`src/lib/cloud/partners-cloud.ts` & `src/integrations/supabase/types.ts`):** Wired `_exchange_rate` parameter into `addCapitalWithCashboxCloud`, `withdrawProfitCloud`, and `withdrawCapitalCloud` ensuring accurate shift ledger accounting and 100% strict typing.
* **2026-11-05 (Storage Stats, Type Deduplication, Written-off Invoices & Reset Data Fix):**
  * **Migration `20261105004000_storage_stats_and_reset_fix.sql`:** Updated `get_user_storage_stats` to allow both Boss and Admins to inspect their own storage and employees without permission failures, and hardened `reset_user_store_data` to clean all cashier transactions under the store's shifts to avoid foreign key violations.
  * **TypeScript Types Deduplication (`src/integrations/supabase/types.ts`):** Removed duplicate declaration of `request_device_reset_secure` preventing TS2300 compiler errors.
  * **Reports & Invoice Types (`src/types/index.ts` & `src/lib/cloud/invoices-cloud.ts`):** Expanded `InvoiceStatus` to include `'written_off'` ensuring clean typing with `Reports.tsx` filters.
* **2026-11-05 (Partner Multi-Currency & Atomic Deposit Rollout):**
  * **Migration `20261105003000_partner_deposit_atomic.sql`:** Implemented `public.partner_deposit_atomic` supporting capital vs. balance deposits, currency conversion to USD base, and atomic cloud shift ledger recording. Upgraded `public.partner_withdrawal_atomic` with multi-currency (`_currency`, `_original_amount`) and active cash shift balance deduction.
  * **Frontend (`src/pages/Partners.tsx` & `src/lib/cloud/partners-cloud.ts`):** Added deposit target selection (Capital vs. Available Balance), enabled currency selector capsules (USD/TRY/SYP), instant USD equivalent preview, and fixed withdrawal false rejections when withdrawing in non-USD currencies by computing currency-based maximums.
* **2026-11-05 (Tasks 1-10 Rollout):** FlowPOS Pro Comprehensive Financial & Architecture Patch:
  * **Task 1:** Whitelisted real DB columns in `TABLE_ALLOWED_COLUMNS` (`src/lib/supabase-store.ts`) for invoices, partners, products, and recurring expenses. Created migration `20261104230000_process_pos_sale_atomic_and_profit_recalc.sql`.
  * **Task 2:** Direct percentage expense sharing in `add_expense_atomic`. Proportional debt profit confirmation in `confirm_partner_debt_profit_atomic`. Updated `Partners.tsx`, `debts-cloud.ts`, and types.
  * **Task 3:** Fixed cloud shift `opened_at` NOT NULL constraint. Passed `shift_id` on debt payments. Created migration `20261104234500_cash_shifts_and_debt_payments_atomic.sql`.
  * **Task 4 & 5:** Implemented `receive_stock_wac` RPC with 8-decimal precision for Weighted Average Cost calculation without zeroing stock cost. Added `currency`, `currency_amount`, and `exchange_rate` to `shift_transactions` and allowed columns. Added `close_cash_shift_atomic` RPC in `cashbox-cloud.ts`.
  * **Task 6 & 7a:** Upgraded `get_owner_id(_user_id)` to resolve cashier/distributor owner while preserving admin/boss as own owners. Hardened RLS policies for `products`, `invoices`, `debts`, and restricted `partners` strictly to admin/boss. Created `writeoff_debt_atomic` with pending profit purging across partners. Frontend `getOwnerIdForInsert` and `expenses-cloud.ts` patched to use `ownerId`.
  * **Task 7b & 8:** Merged proportional partner profit release directly into `record_debt_payment_atomic` with active shift linking. Created `accounting_period_closures` table with RLS and `close_accounting_period_atomic` RPC. Added closures to `TABLE_ALLOWED_COLUMNS` and `types.ts`. Excluded `written_off` invoices from `Reports.tsx` sales and profits.
  * **Plan 9 (Cache-First Settings Engine):** Created `src/lib/settings-storage.ts` (`getStoredSettingsLocally`, `saveSettingsLocally`) and `src/hooks/use-settings.tsx` (`useFastSettings`) providing 0ms synchronous local retrieval from `localStorage` (`hyperpos_settings_v1`) with quiet non-blocking background cloud revalidation.
  * **Plan 10 (SmartToast Anti-Clipping & Device Reset RPC):** Updated `src/components/ui/SmartToast.tsx` with flexible wrap containers (`break-words whitespace-normal leading-snug`, `select-text`) preventing text cut-off. Created migration `supabase/migrations/20261105001000_device_reset_secure.sql` for secure cashier/user device unbinding (`request_device_reset_secure`).
* **2026-10-24:** Phase 1 - Feature Error Boundary, Lazy Loading & Manual Chunks:
  * Created `src/components/debug/FeatureErrorBoundary.tsx` with unified `captureError` integration (`source: 'react_boundary'`).
  * Converted 7 heavy pages in `src/App.tsx` (`Products`, `Customers`, `Services`, `Invoices`, `InvoiceTracking`, `Expenses`, `CashShifts`) to `React.lazy` with idle background preloading (`requestIdleCallback` after 2500ms).
  * Wrapped all application routes with `<FeatureErrorBoundary featureName="...">` while maintaining `ProtectedRoute`, `RoleGuard`, and frozen module integrity.
  * Configured `build.rollupOptions.output.manualChunks` in `vite.config.ts`, isolating heavy libraries into `vendor-charts`, `vendor-pdf`, `vendor-excel`, and `vendor-radix`.
  * Reduced `Reports` chunk from 2,035 kB down to 254 kB (8x smaller), stripped 735 kB from the main entry chunk, and accelerated build time from 68s to 21s.
* **2026-10-24 (`721b07c`):** v1.0.72 - Completed The 10 Improvements Plan & Dynamic Notification Theming:
  1. Default Weekly Invoices: Default filter in `Invoices.tsx` is 'week' for both listing and KPI cards.
  2. Fixed Products Tabs: 3-column fixed responsive grid with vertical icons on mobile, zero clipping.
  3. Default UI Scale: First-time scale set to 80% (11.2px) across config, HTML, and CSS.
  4. Purchases Layout & Atomic Edit: Responsive 2-column buttons, 42rem constrained dialogs, mobile vertical item cards, and atomic `edit_purchase_invoice_atomic` SQL migration with WAC recalculation, negative stock guard, and 'superseded' audit tracking.
  5. Debts & Multi-Currency Statements: All debt cards and reports formatted with `formatInCurrency` displaying `= X $`, expandable accordion invoice items in customer statements, and share canvas utilizing stored invoice exchange rates.
  6. Maintenance in Sales Cart: Integrated maintenance capsule trigger right inside `CartPanel.tsx` next to Shopping Cart, removing clutter from header and catalog.
  7. Services Capsule Buttons: Transformed dropdowns and radio buttons in `Services.tsx` into theme-colored `rounded-full h-9 px-4` capsule button groups.
  8. Cash Shifts Local Currency & Live USD: Live currency exchange conversion display on start/close dialogs ("يعادل X $"), shifts stored with currency and rate, while base storage remains USD.
  9. Default Reports Graphical Summary: Default `activeReport = 'sales'` and `viewTab = 'summary'`.
  10. Consolidated Appearance & Dynamic Toasts: Unified Theme, Fonts, Scale, and Layout under a single draft state with floating FAB save button, and dynamic `hsl(var(--primary))` theming for SmartToast borders, glow, actions, and progress countdown.
  11. BossPanel User Licenses: Added safe suspension and reactivation for active trial and purchased licenses with confirmation modals, without touching user records.
* **2026-10-22:** Refined Compact SmartToast & Purged Shockwave Burst Effects:
  * Removed explosion rings, edge flares, `@keyframes lateralShockwave`, and harsh impact audio (`playBurstSound()`) from `SmartToast.tsx` and `src/index.css`.
  * Reduced card footprint from `max-w-[29rem]` (~464px) to `max-w-[22.5rem] sm:max-w-[23.5rem]` (~360px-376px) with zero content or button clipping.
  * Harmonized text, background, and borders with CSS theme variables across Light, Dark, and Blur (`.blur-theme`) glassmorphism modes.
  * Preserved full swipe gestures (up, left, right), tactile countdown pause & resume physics on touch/cursor, multi-item details, and Print/Share buttons.
* **2026-10-22 (`0a72c01`):** Thermal Printing & Bluetooth Pairing Realism Protocol:
  * Cleaned `src/lib/native-print.ts`: purged the 4 static mock Bluetooth devices from discovery fallback. If no hardware is detected, `searchBluetoothPrinters` returns an empty array `[]` ("لم يتم العثور على طابعات").
  * Fixed `connectAndTestBluetoothPrinter`: removed mock success. System returns `success: false` if plugin is missing or connection fails, and only saves printer configuration after actual connection and test data transmission succeed.
  * Added `isBluetoothSupported` runtime detection for Cordova `BluetoothSerial`, Capacitor plugin, and Web Bluetooth.
  * Updated `src/pages/Settings.tsx` (`handleStartSearchBT`, `handleSelectBTDevice`, discovery dialog): distinguishes clearly between discovered devices, live connecting state, verified connected printers, and unsupported environments with strict UCL adherence.
* **2026-10-22 (`3ded844`):** Granular Notification Events Management & Muted Default Events.
  * Muted (disabled by default) 4 specific notifications without deleting code:
    1. Event 19: `invoices_share_image_generating` ("جاري إنشاء صورة الفاتورة للمشاركة...").
    2. Event 20: `invoices_copied_clipboard` ("تم نسخ تفاصيل الفاتورة بنجاح").
    3. Event 48: `sync_completed_success` ("تمت المزامنة بنجاح ✓" / "تم ترحيل بياناتك إلى السحابة").
    4. Event 49: `sync_offline_queued_warning` ("تم حفظ فاتورة البيع المؤجل أوفلاين...").
  * Categorized all system notifications in `Settings -> Notifications` into 7 organized groups matching the repository audit (POS & Sales, Invoices & Refunds, Debts & Customers, Products & Stock, Cashbox & Shifts, Sync & Backup, Settings & System).
  * Provided direct event titles with individual Switch toggles, count badges, and persistent state in `hyperpos_settings_v1` and Supabase JSONB settings.
  * Created transparent gatekeeper `isNotificationEventAllowed` and `resolveEventKeyFromText` in `src/lib/notification-events-config.ts` integrated directly into `use-smart-toast.ts`, `toast-config.ts`, and `BackgroundSyncIndicator.tsx`.
* **2026-10-22 (`3ad165e`):** Removed legacy test notification trigger card and native permission prompt from `Settings.tsx`.
* **2026-10-22:** Configured `UI/UX Pro Max` skill and rule (`07_ui_ux_pro_max_guidelines.md`) on standby mode. Established the 8 Immutable Invariants (SQL Safety, Anti-Data-Loss, UI Consistency Lock).
* **2026-10-22 (`f03e6b9`):** Autonomous Meta-Architect workflow initialization: Spec-Driven Planning, Ponytail surgical edits, Code Review Auditor, Persistent Memory, and Obsidian ADR documentation bridge.
* **2026-10-22 (`b5dba73`):** Web notification compatibility update and `src/lib/sonner-bridge.ts` integration.
* **2026-10-22 (`5acefb3`):** Unified in-app Dynamic Island interactive toast system with tactile freeze & resume countdown physics on touch/hover, lateral shockwaves, multilingual keywords (AR/EN/TR).

---

* **2026-11-06:** Circular Theme Reveal Transition (Front-End 100%):
  * Implemented pure front-end circular reveal transition using native `document.startViewTransition` with circle `clip-path` expanding from touch/cursor coordinates to screen corners (400ms `cubic-bezier(0.4, 0, 0.2, 1)`).
  * Added View Transition CSS rules to `src/index.css` (disabling default cross-fade animation, elevating new transition root to z-index 9999, and respecting `prefers-reduced-motion`).
  * Created central transition helper in `src/lib/theme-transition.ts` with automatic coordinates calculation from mouse/touch events and silent safe fallback.
  * Extended `useTheme` context in `src/hooks/use-theme.tsx` to support optional event parameter across `setMode`, `setColor`, `setThemeStyle`, `setTheme`, `setFullTheme`, and `previewTheme`.
  * Connected UI callers in `ThemeSection.tsx`, `Appearance.tsx`, `SetupWizard.tsx`, and `PrivacyPolicyScreen.tsx`.

* **2026-11-06 (Comprehensive Audit & Stabilization: Accounting, Activity Log, Archive & i18n):**
  * **Stage 1 (Financial & Accounting Core):** Fixed `recalc_pos_invoice_profit` SQL migration to check `COALESCE(unit, 'piece') = 'bulk'` before applying `conversion_factor`; shielded wholesale pricing card from cashier roles in `ProductDetailsDialog.tsx`; deferred credit sale uncollected profits proportionally to paid amount in `debt-sale-handler.ts`; resolved cashier cloud profit insertion with `getOwnerIdForInsert()` in `profits-cloud.ts`.
  * **Activity Log & Auditing:** Added capital deposit/withdrawal tracking for partners in `Partners.tsx`; expanded `activityTypeLabels` to support AR, EN, TR, and FR; added "الشركاء ورأس المال" and "المصاريف" filter pills and `PartnerFinancialDetailsBox` in `ActivityLogSection.tsx`.
  * **Archive & Notifications Overhaul:** Expanded general archive in `ArchiveSection.tsx` into 6 subtabs (`invoices`, `debts`, `products`, `expenses`, `purchases`, `deleted`) with Supabase cloud audit log synchronization; added persistent notification archiving with 72-hour auto-archive in `Notifications.tsx` and `use-notifications.tsx`; resolved text clipping with responsive wrapping.
  * **Complete i18n & RTL/LTR Stabilization:** Achieved 100% key completeness across all 4 supported foreign languages (en, tr, fa, ku) in `src/lib/i18n.ts` (0 missing keys); replaced hardcoded Arabic table headers with dynamic `t()` keys and logical `text-start` across the 4 major report tables (`PurchaseInvoicesReport`, `SalesDetailedReport`, `DebtsReport`, `MaintenanceReport`); eliminated search bar clipping by replacing hardcoded `right-3`/`pr-9` with logical CSS `start-3`/`ps-9 pe-3` across all pages; resolved MobileMenuTrigger burger overlap in `Reports.tsx` with responsive padding; rotated back button `ArrowRight` with `rtl:rotate-0 ltr:rotate-180`; added `formatAppDate` in `src/lib/utils.ts` and dynamic date locale across reports, debts, invoices, and native sharing.

* **2026-11-06 (System-Wide Runtime Reference Hardening):**
  * **Profile Management (`ProfileManagement.tsx`):** Added missing `Phone` and `KeyRound` icon imports from `lucide-react` to resolve `ReferenceError: Phone is not defined`.
  * **Cashier Product Details (`ProductDetailsDialog.tsx`):** Destructured `isCashier` from `useUserRole()` to resolve `ReferenceError: isCashier is not defined`.
  * **Notifications Archiving (`Notifications.tsx`):** Defined `handleArchiveBroadcast` utilizing `addArchivedNotification` and `toast.success`.
  * **Theme Customization (`ThemeSection.tsx`):** Destructured `setMode`, `setColor`, and `setThemeStyle` from `useTheme()` for standalone fallback execution.
  * **Report Currency Banner (`ReportCurrencyBanner.tsx`):** Fixed currency filtering from non-existent `!c.isUsd` to `c.code !== 'USD'` and resolved `ResolvedCurrencyMeta` type compatibility via `resolveCurrencyMeta('USD')`.

* **2026-11-06 (Activity Log & Settings Tab Error Boundary Hardening):**
  * **ActivityLogSection Crash Fix:** Fixed `Uncaught ReferenceError: language is not defined` inside `ActivityCard` in `src/components/settings/ActivityLogSection.tsx` by introducing dual protection (`propLanguage` with `useLanguage()` hook fallback and Arabic/English fallback).
  * **Cloud Activity Log Sync Alignment:** Corrected cloud table query in `ActivityLogSection.tsx` from plural `activity_logs` to singular `activity_log`, aligned database columns (`created_at`, `actor_name`, `action_type`, `metadata`), and supported store owner resolution via `getOwnerIdForInsert()`.
  * **Settings Tab Isolation:** Wrapped `{renderTabContent()}` in `src/pages/Settings.tsx` with `<FeatureErrorBoundary featureName={`تبويب الإعدادات: ${activeTab || 'العام'}`} compact>` to ensure any runtime error in an individual tab (e.g., Activity Log, Users) never crashes the entire Settings screen or halts other tabs.
  * **Relocated Tabs Handling:** Added explicit redirects and fallbacks in `renderTabContent()`:
    * `case 'theme': <Navigate to="/appearance" replace />` for bookmarks or external links.
    * `case 'currencies':` rendering `<FinanceSettingsSection ... />` to seamlessly support direct links to currency configuration.

* **2026-11-06 (Store Phone Verification & Atomic Transfer Engine):**
  * **Stage 3 & 4 (Verification Modal & Settings Integration):** Created `StorePhoneVerificationDialog.tsx` supporting dual verification workflows:
    1. Direct password re-authentication for available phone numbers via `assign_store_and_profile_phone`.
    2. 6-digit Telegram OTP verification and atomic ownership transfer via Edge Function `telegram-auth` (`request_phone_transfer_otp`) and RPC `complete_phone_transfer` for numbers registered to other accounts.
    * Linked pre-save check directly into `Settings.tsx` (`handleSaveSettings` and `check_store_phone_status`), triggering verification modals before persisting store settings.

* **2026-11-08 (Build 458 - Comprehensive Security & Financial Logic Remediation via EGM):**
  * **P0-4 Double Profit Reversal Eliminated (`invoices-cloud.ts`):** Removed redundant client-side calls to `revertProfitDistributionCloud` in `refundInvoiceCloud` and `refundInvoicePartialCloud`, since server-side RPCs already execute atomic partner profit reversals.
  * **P1-23 Atomic Expense Reversal (`expenses-cloud.ts`):** Rewired `deleteExpenseCloud` to execute server-side `delete_expense_atomic` RPC with `FOR UPDATE` locking on partners and soft-delete audit trail (`is_reversed = true`), with full offline-first queue support and fallback.
  * **PostgreSQL Remediation Bundle (`20261108160000_comprehensive_financial_and_security_remediation.sql`):**
    * Added comprehensive `DROP FUNCTION IF EXISTS` clauses across all signatures to permanently prevent PostgreSQL `ERROR 42P13`.
    * **P1-5 Bulk Carton Restoring:** Updated `refund_invoice_atomic` to multiply quantity by `conversion_factor` for `unit = 'bulk'` items.
    * **P0-5 Proportional Debt Profit Release:** Updated `record_debt_payment_atomic` to prevent flipping `isDebt: false` on partial debt payments and calculate proportional installment release (`installment_ratio`), preventing negative partner balances.
    * **P1-25 COGS Derivation:** Updated `close_accounting_period_atomic` to derive cost of goods sold directly from `invoice_items` (`cost_price * quantity`) instead of the non-existent `invoices.total_cost` column.
    * **P1-23 Atomic Expense Deletion:** Created `delete_expense_atomic` to restore partner balances and record soft-reversals atomically.
    * **Phase 6 Data Backfill:** Automated query to purge 35 phantom debts linked to cash invoices (`payment_type = 'cash'`) and recalculate `customers.total_debt`.
  * **EGM Architecture Documentation:** Updated `docs/designs/security-and-financial-audit.md` with Section 12 detailing the root-cause reconciliation.

* **2026-11-08 (Build 459 - Instant PIN Auto-Submit & Biometric Unlock via EGM):**
  * **Instant PIN Auto-Submit (`AppLockOverlay.tsx`):** Implemented zero-latency automatic PIN verification upon entering the target length (`pinLength`), unlocking the POS terminal immediately without requiring an extra confirmation button click.
  * **Incorrect PIN Feedback:** Added native-style horizontal shake animation, auto-clearing of entered digits for instant re-entry, and clear red error message ("كلمة المرور خاطئة"), while preserving the 5-attempt rate limit.
  * **Cross-Platform Biometric Authentication Engine (`biometric-auth.ts`):** Created a zero-dependency hybrid biometric engine supporting native Capacitor biometric auth on mobile and WebAuthn platform authenticators (`window.PublicKeyCredential`) across Desktop/PWA/Electron (Windows Hello, Touch ID, Face ID, Android Biometrics).
  * **Biometric Auto-Prompt & UI Integration:** Added automatic biometric prompt on app lock display, dedicated `Fingerprint` keypad trigger, and biometric toggle in `ProfileManagement.tsx`.
  * **Security Lock Architecture Update:** Documented Stage 2 specifications in Section 10 of `docs/designs/security-lock-and-theme-animation.md`.

* **2026-11-08 (Build 460 - Native Android APK Biometric Integration & Synchronization):**
  * **Native Biometric Plugin Installed:** Added `@aparajita/capacitor-biometric-auth` (v10.0.0) configured specifically for Capacitor 8+ Android runtime.
  * **Android Manifest Permissions:** Added `<uses-permission android:name="android.permission.USE_BIOMETRIC" />` and `<uses-permission android:name="android.permission.USE_FINGERPRINT" />` to `android/app/src/main/AndroidManifest.xml`.
  * **Unified Mobile & Web Architecture (`biometric-auth.ts`):** Directly linked `BiometricAuth.checkBiometry()` and `BiometricAuth.authenticate()` for Android APK / Capacitor native runtime, ensuring biometrics appear and function on APK, while retaining WebAuthn platform authentication on web/desktop.
  * **Capacitor Sync:** Executed `npx cap sync android` to sync web assets and register the native `BiometricAuthNative` plugin in Android Gradle project.

* **2026-11-08 (Build 461 - Strict PIN Purge, Biometric Coupling & Two-Step Sign Out via EGM):**
  * **Strict PIN & Biometric Purge on Disable (`use-app-lock.tsx`):** Enforced complete erasure of stored salted SHA-256 hash, salt, length, biometric credentials, and lockout state from `localStorage` whenever App Lock is toggled off (`enabled: false`). Re-enabling the lock strictly requires creating a new PIN.
  * **Strict Biometric Coupling (`use-app-lock.tsx` & `ProfileManagement.tsx`):** Locked biometric authentication strictly behind an active App Lock and existing PIN; disabling the lock automatically revokes and removes biometric settings.
  * **Quick PIN Change Button (`ProfileManagement.tsx`):** Added a dedicated "تغيير رمز الـ PIN" trigger allowing active users to update their PIN without turning off security.
  * **Two-Step Sign-Out Double Confirmation (`AppLockOverlay.tsx`):** Replaced the single emergency sign-out modal with a strict 2-step confirmation sequence (Step 1: Intent confirmation -> Step 2: Critical in-memory cart purge warning) before calling `signOut()`, eliminating accidental cashier shift cancellations.
  * **Keypad Button Dimension Invariance (`AppLockOverlay.tsx`):** Preserved exact keypad button dimensions (h-14, rounded-2xl) for the biometric and utility triggers, preventing touch layout distortion.
  * **Capacitor & Android Synchronization:** Built production assets (`npm run build`) and executed `npx cap sync android` with 10 native plugins verified.

* **2026-11-08 (Build 462 - Touch Responsiveness, Inline Modal & Mandatory PIN Re-setup on Recovery):**
  * **Touch Responsiveness Fixed (`AppLockOverlay.tsx`):** Replaced `touch-none` with `select-none touch-manipulation` to restore full touch gesture and click compatibility on Android WebView / APK.
  * **Radix Portal Violation Eliminated (`AppLockOverlay.tsx`):** Removed `<AlertDialog>` (Radix Portal rendering at z-50 under the z-[9999] overlay) and replaced it with a dedicated high-priority Inline Div Modal (`z-[10000]`), guaranteeing immediate touch responsiveness and zero z-index conflicts.
  * **Emergency Recovery Tagging (`AppLockOverlay.tsx` & `use-auth.tsx`):** When "نسيت الرمز" double-confirmation confirms sign out, marks `flowpos_pin_reset_required_${userId} = true`, whitelisted in `clearAllUserSessionCaches` to survive logout.
  * **Automated PIN Invalidation & Cloud RPC (`use-app-lock.tsx` & Supabase Migration):** On master credentials login with the reset flag, automatically purges local credentials, invokes `clear_user_pin` RPC, and sets `requiresPinSetup = true`.
  * **Mandatory Post-Login PIN Setup (`MandatoryPinSetupModal.tsx` & `App.tsx`):** Created `MandatoryPinSetupModal` locking down the app layout via `inert` until the user defines and confirms a new 4-8 digit PIN, automatically restoring terminal security.

## ⚠️ Known Technical Debt & Edge Cases
1. **Large Bundle Size:** Main chunk exceeds 800KB gzipped. Dynamic code-splitting on heavy reports (`Reports.tsx`, `BossPanel.tsx`) is advised for future performance optimization.
2. **Offline Refund Currency Conversion:** Historical invoices refunded offline must resolve historical exchange rates from invoice snapshots to prevent currency drift.
3. **Capacitor Storage Quotas:** High-resolution product images must be saved to filesystem cache (`offline-image-store.ts`) rather than base64 strings in localStorage.

---

## 🎯 Next Logical Milestones
- [ ] Implement and test edge-case recovery for interrupted network connections during multi-item partial refunds.
- [ ] Add chunk code-splitting for reports to improve initial POS touch screen boot speed.
- [ ] Connect Obsidian knowledge base bridge for automated ADR documentation sync.
