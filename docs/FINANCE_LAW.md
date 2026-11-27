# FINANCE LAW — القانون المالي الإلزامي

> **Binding for every agent and model that touches financial logic. Not on-demand. Zero tolerance for error.**
> Version 1.0 · 2026-11-23 · owner decisions D-01…D-06 (section 3). Read this whole file before starting any financial task.

## 0. Scope — when this law applies
It applies if the task touches **any** of: `money-engine`, `profit-engine`, `report-metrics`, `invoice-profit`, `unified-transactions`,
`cashbox-store`, the local stores of invoices/debts/expenses/partners/profits/capital, `src/lib/cloud/` files for
cashbox, debts, expenses, invoices, partners, pos-sale-atomic, profits, profit-ledger, purchases, suppliers, customer-credit, accounting-admin,
the sale handlers, money cases in `sync-operation-processor`, the pages POS / Invoices / Debts / Expenses / Partners / Cashbox / CashShifts /
Purchases / Reports, any `supabase/migrations` that touches an accounting RPC, **or any review/audit/report that judges financial correctness**.
Also if the request mentions profit, tax, discount, debt, refund, drawer, shift, partner, expense, exchange rate or rounding. When in doubt: it applies.

## 1. Authority and conflicts
1. This law wins over code, SQL, comments and older documents. `FINANCIAL_FORMULAS_AR.md` is examples only. (D-02)
2. If code or SQL differs from this law: stop that part, record it as a deviation (section 6) and report it to the owner. **Never change financial
   behaviour on your own** (anything that changes a stored amount, a rounding result, who receives what, or when something is posted) and never claim compliance meanwhile.
3. SQL / RPC / migration changes follow the AGENTS.md database rule: show the proposal, wait for explicit approval.

## 2. Invariants — each one is both a requirement and a review criterion
Proof codes: **T** = test that imports and runs production code (`npm run finance:check`) · **R-xx** = reconciliation query
(`supabase/tests/finance_reconcile_readonly.sql`) · **S** = enforced in SQL, no automated test yet (KD-03) · **review** = checked by reading code.

| ID | Rule | Proof |
|---|---|---|
| F-01 | USD is the only accounting base. Every stored cost, price, profit, ledger and cash amount is USD; a foreign-currency amount is stored beside its USD value with the rate used. | T, S |
| F-02 | Internal precision is 8 decimals (`round8`). Display rounding happens only at presentation, with the currency catalog's decimals, and never changes a stored value. | T |
| F-03 | No float approximations in money code: use the `money-engine` helpers (`round8`, `roundCurrency`, `precise*`). | T, review |
| F-04 | Every invoice stores its exchange rate and currency symbol at creation; a historical invoice is never recomputed with today's rate. | T, S |
| F-05 | No hardcoded `$`, currency codes or fallback rates in calculation code. | review |
| F-06 | A foreign-currency amount sent to an RPC must satisfy `original_amount ≈ amount_usd × rate`. Server tolerance is a safety net, never the target. | S, review |
| F-07 | Tax is computed after discount. Tax is never profit and never cost. | T |
| F-08 | A discount is subtracted in full from revenue and profit, allocated to lines proportionally; a zero subtotal yields 0 (no division). | T, S |
| F-09 | Tax-inclusive mode: `f = 1/(1+rate/100)`; `profit = (subtotal − discount)·f − COGS`. | T, S |
| F-10 | `COGS = Σ cost × qty`; stored profit has 8 decimals. | T |
| F-11 | Weighted-average cost is recomputed on every receipt, return and edit; free goods (unit cost 0) never lower it; stock never goes below 0 unless the owner's allow-negative setting is on. | S |
| F-12 | A credit sale's profit is PENDING. It is confirmed in proportion to payments; the confirmed parts sum exactly to the pending profit and the last payment closes the remainder. | T, S |
| F-13 | Debt: `total_paid + remaining = total_debt`, `remaining ≥ 0`; status is `fully_paid` when remaining ≤ 0, `partially_paid` when paid > 0, else `due`; a payment never exceeds the remaining amount. | R-01, R-02, S |
| F-14 | A refund is atomic and idempotent (operation id): stock, debt, customer totals, profit, partner shares and the drawer movement change in one transaction; nothing is hard-deleted. | S |
| F-15 | Cash returned = invoice total (cash sale) or the amount actually paid (credit sale). Non-cash (digital) invoices never touch the drawer. A partial refund uses the factor `total / subtotal`. | S |
| F-16 | A refund of an invoice whose original shift is closed posts its cash-out to the currently open shift. | S |
| F-17 | Every cash movement is exactly one `shift_transactions` row (type, USD amount, original amount, rate, reference_id). For debts, expenses, refunds, partner withdrawals and supplier payments it is written by the same atomic RPC that changes the business record; the client never writes a duplicate of those. (Cash-sale movements are written by the client today — KD-06.) | R-04, R-05b, golden, review |
| F-18 | `shift_transactions` is the source of truth. The drawer balance is `opening + inflows − outflows` of its movements and is recomputed from them when the shift closes (`close_cash_shift_atomic`). `cash_shifts.expected_balance` is a cache updated by the RPCs that post movements; during an open shift it may lag for movements the client writes (KD-06). Every movement belongs to a shift of the same owner and is not posted after that shift closed. | R-03, golden, S |
| F-19 | A movement is posted once: `(shift_id, type, reference_id)` is unique. | R-04 |
| F-20 | Offline money operations carry a stable operation id and replay idempotently. If their shift is closed when they sync, they stay PENDING and are shown to the owner for manual reconciliation — never moved to another shift automatically. (D-05) | S, review |
| F-21 | Partner profit is split per category of the invoice's profit: a category partner takes their category share FIRST (cumulative cap 100% per category); general partners then take their percentage of the REMAINING profit (cumulative cap 100%). A single general partner may hold 100% of that remainder, after which no other general partner fits. Totals above 100% are rejected (general share and expense share separately). Any unallocated remainder (no other partner, or total below 100%) stays with the store owner and is credited to no partner. Cash sales confirm partner profit immediately; credit sales keep it pending. (D-07) | S |
| F-22 | Reversing an expense restores the partner balances and the drawer; the movement is found by `reference_id = expense id`. | R-05a, R-05b, S |
| F-23 | A partner withdrawal takes profit first, then capital, in ONE atomic call (type `auto`), idempotent by operation id. Deposits are online-only (no operation id). | S, review |
| F-24 | A closed accounting period is immutable: the server blocks changes dated inside it (`assert_period_open`). | S |
| F-25 | Financial columns are written only by atomic RPCs, never by direct client table writes. | S, review |
| F-26 | A rounding difference of at most 0.05 USD in a settlement is absorbed by the server settlement and noted — never silently dropped. | S |
| F-27 | **Implemented in migration `20261123071000` (apply pending, KD-01).** A debt paid in a foreign currency is credited at the INVOICE's original rate; the difference from the payment-day value is an FX difference, shown as its own line outside sales profit, added at the bottom of the net result, never distributed to partners as merchandise profit. (D-04, D-06) | golden FX-1..FX-7, R-06 |

## 3. Owner decisions (binding)
- **D-01** Proof = tests that run production code + read-only reconciliation queries.
- **D-02** The law wins over code/SQL, but no financial behaviour changes without the owner's explicit approval.
- **D-03** Fix-and-retry until every gate is green; if the same check fails 3 rounds in a row, stop and report the blocker.
- **D-04** Foreign-currency debt payments use the invoice's original rate and record an FX difference (target F-27; current behaviour differs — KD-01).
- **D-05** An offline cash operation whose shift is closed at sync time stays pending for manual reconciliation.
- **D-06** The FX difference is a separate line outside sales profit, added at the end of the net result.
- **D-08** (2026-11-23) The profit not allocated to any partner belongs to the store owner.
- **D-09** (2026-11-23) Partner EXPENSE rule, for NEW expenses and NEW profit only (nothing recorded is recalculated): (1) category partners pay their expense percentage of the TOTAL expense first; (2) general partners pay their percentage of what REMAINS; (3) the store owner keeps the rest, as a remainder, never entered as a number. Percentages are whole numbers only; amounts keep cents. General expense percentages sum to at most 100; category expense percentages sum to at most 100 on their own. Profit (F-21) is unchanged. Reversal uses the stored distributions. Implemented in migration `20261123074000` (apply pending), tested in the golden suite (EXPSHARE-A and EXPSHARE-B with the owner's exact numbers, EXPSHARE-V for the refusals) and in R-08.
- **D-10** (2026-11-23) Partner withdrawals in any currency. The accounting base stays USD. CAPITAL is held in USD at the deposit: a capital withdrawal in a foreign currency is valued at the ORIGINAL deposit rate (weighted over the capital deposits); the server computes the USD amount. PROFIT is held in USD: a profit withdrawal in a foreign currency is valued at TODAY's rate for that currency. A withdrawal may be split into several rows and repeated. The automatic split (profit first, then capital) is for USD only; a foreign-currency withdrawal is two rows. Implemented in migration `20261123075000` (apply pending), tested in the golden suite (D10 checks) and in `partner-fx.test.ts`.
- **D-11** (2026-11-24, implemented) Cash sale: the invoice and its drawer movement are written in ONE transaction by `process_pos_sale_with_drawer_atomic` (migration `20261124080100`), with the exchange rate and the foreign amount. Replays post once; a closed shift refuses the whole sale. Tax: the server is authoritative; a different total is shown and logged (`sale_total_mismatch`), never silently replaced.
- **D-12** (2026-11-24, implemented) A refund after a period end does not change that period: the sale keeps its original profit (`profit_records.gross_profit`) and the refund day (`reversed_at`). Pending profit of a period is valued as of its end (later collections do not reduce it). A reversed expense counts for every period that ends before its reversal day.
- **D-13** (2026-11-24, implemented) Editing a paid purchase: the replacement keeps the original drawer reference (`paid_shift_id`); no second drawer movement; the paid amount above the new total is shown as `supplier_credit` and matches the supplier ledger.
- **D-14** (2026-11-24, implemented) Stock never goes below zero unless `stores.allow_negative_stock` is on (default off: the sale is refused). Free goods (unit cost 0) keep the weighted-average cost (F-11).
- **D-07** (2026-11-23) Partner shares are "not above 100%", not "equal 100%": category partners are paid first from their category's profit; general partners' percentages apply to what remains.

## 4. Definition of Done — the gates
| Gate | Requirement | Command / evidence |
|---|---|---|
| G1 | Finance gates are GREEN | `npm run finance:check` (app code) **and** `npm run finance:sql` (golden SQL scenarios on an in-memory database built from the migrations, never the live DB) — paste both outputs |
| G2 | Build, types, maps | `npm run build` exit 0 · `npx tsc --noEmit -p tsconfig.app.json` adds no errors · `npm run maps:check` |
| G3 | Each money rule you changed or added has a case in a test that **imports production code**, and you saw it fail before the fix (new rules: fail first, then pass). A test that re-implements the logic itself is a *model* and is not evidence (KD-02). | test name + before/after output |
| G4 | If an RPC/SQL changed or a money data flow changed: every reconciliation query returns zero rows | owner runs `finance_reconcile_readonly.sql`, or approves you running it; paste the result |
| G5 | Evidence report | template in section 5.5 |

**No gate output = not done.** "Looks correct", "should work" and "reviewed by reading" are not evidence.

## 5. Review and fix protocol (this ends the "still incomplete" ping-pong between models)
5.1 **What may block a task:** (a) a violated invariant F-xx with evidence, (b) a RED gate, (c) a change that worsens an open deviation. Anything else is a
**SUGGESTION**: list it separately; it never reopens finished work and is never required.
5.2 **Finding format:** `BLOCKER · F-xx or gate · evidence (file:line / test output / query rows) · how to reproduce · minimal fix`.
A finding without an F-xx or a RED gate, or without evidence, is void.
5.3 **Reviewer duties:** run G1 and G2 first and paste the output; list **all** blockers in one pass (no drip-feeding). A re-review may only (i) verify the listed
blockers are fixed and (ii) examine files changed since the last review. A new blocker on an unchanged file is allowed only if it says "missed in round N" and cites
evidence. Each round ends with a verdict: `GREEN` (zero blockers) or `RED` (list).
5.4 **Fixer loop:** fix → run all gates → repeat until every gate is green. If the *same* check fails 3 consecutive rounds, stop and report the blocker and the three
attempts to the owner (D-03). Never weaken, skip or delete a check, and never change a test's expected value to reach green; if an expectation is wrong, cite the
invariant it contradicts and ask the owner when behaviour is affected.
5.5 **Evidence report (Arabic, to the owner):** invariants touched (F-xx) · files changed · G1 output · G2 results · G3 test names (before/after) · G4 rows or "not applicable" ·
deviations touched (KD-xx) · suggestions (non-blocking) · verdict GREEN/RED.
5.6 **Handing work to another model:** give it this file, the last G1 output and the open blocker list. It starts from the list, not from scratch.

## 6. Known deviations (do not "fix" without approval; do not report as new bugs)
- **KD-01** FX on debts (F-27). SQL golden-tested (FX-1..FX-7) and **applied to the live database on 2026-11-23** (`20261123071000`). The live function now credits same-currency foreign debts at the invoice rate and records the FX difference; the app side ships with the next build/merge. App side is done and safe before the migration: payment dialogs (Debts, Invoices) credit at the invoice rate through `src/lib/debt-fx.ts` (production test `debt-fx.test.ts`), and Reports shows the FX difference as its own line inside the net result (empty until the column exists). The server stays the authority.
- **KD-02** The big audit suite (`comprehensive-accounting-audit`, 120 cases) re-implements its logic and 77 of its 121 cases are descriptive text. Only 44 of them run production code (59 production cases overall with the newer tests). Convert cases to production calls as the logic becomes callable.
- **KD-03** SQL logic coverage. First live reconciliation run (2026-11-23, owner-approved, read-only): R-01…R-05b returned 0 violations, but the live database held 0 shifts and 0 shift transactions, so the drawer queries verified nothing there. Mitigation: the golden harness (`npm run finance:sql`, 74 checks) now exercises debts (USD + FX), expenses, sale→refund, partner withdrawal, shift close and the reconciliation queries (with negative tests) on a database replayed from the migrations; function bodies were proven identical to live by `md5(prosrc)`. Still uncovered by scenarios: supplier payments/purchases, quick purchases, store-credit payout, partial refunds, accounting-period close.
- **KD-04** ~~Partner shares "equal 100" vs "not above 100"~~ — CLOSED by D-07 (the server's rule is the intended one; the older reference text was corrected).
- **KD-05** `src/integrations/supabase/types.ts` is stale against the live RPC signatures. Use `supabase/MAP.md` (migration-derived) and verify against the live DB.
- **KD-06** Cash-sale drawer movements (`type='sale'` and related deposit rows) are written by the client, not by `process_pos_sale_atomic`, and do not update `cash_shifts.expected_balance`; the cache is corrected only when the shift closes. Reconcile with R-03/R-04 and the closing recomputation; R-07 shows the drift (information only). Fix golden-tested (SALEPOST, 10 checks) and **applied on 2026-11-23, but not yet used**: migration `20261123072000` adds `post_shift_sale_atomic` (idempotent by operation id, updates `expected_balance`, rejects closed shifts). The sale RPC is untouched; the app still writes the movement itself until the owner approves switching `addSalesToShift` to the RPC (the client must then stop its own insert).
- **KD-10** Refunds before this audit: a refund zeroes the stored profit of the invoice. The period rule (D-12) reads the original profit from `profit_records`; invoices without a profit record keep the old behaviour. Offline reports do not know the refund day (the ledger cache has no profit records until it is refreshed online).
- **KD-11** The UI for `supplier_credit` on the replacement purchase invoice is not shown yet (the value is stored and matches the ledger). The allow-negative setting has no screen yet (set it in the store row by the owner).
- **KD-09** The partner expense rule (D-09) applies to expenses recorded after migration `20261123074000` is applied. Expenses recorded before it keep their stored distributions, which were computed with the earlier rule (each partner's percentage of the total). No recalculation was made, by owner decision.
- **KD-08** Owner store reset (owner decision, 2026-11-23). The store OWNER (not only Boss) may purge THIS store's data through `reset_user_store_data` (migration `20261123073000`): invoices, debts and their payments, drawer movements, expenses, partners and their ledger, customers, suppliers, purchases, period closures and library data are deleted. Products, warehouses and settings are kept; product stock is set to 0. This is a deliberate exception to F-14/F-25 ("never hard-deleted") and to the direct-delete guards for this one owner-confirmed action only. Safeguards in the app: password, a 10-second countdown, a backup saved to the device before the wipe (the wipe aborts if the backup fails), online only, cloud cleared before the device, the offline queue (`posflow_sync_pending_*`) is never removed. Cashiers cannot run it (tested). The activity log is kept and records each reset. Every other store is untouched (tested). Golden scenario: RESET (fails without the migration).
- **KD-07** (FIXED and applied live on 2026-11-23, migration `20261123070000`) `refund_invoice_atomic` failed in production with `column reference "invoice_id" is ambiguous` (OUT parameter clashed with the `profit_records` column) — every refund hit it. Fix: migration `20261123070000`; golden REFUND scenario goes RED without it.

## 7. Reconciliation queries
`supabase/tests/finance_reconcile_readonly.sql` — SELECT-only, each must return zero rows (a zero over an empty table proves nothing: always state how many rows were checked): R-01 debt arithmetic (F-13) · R-02 debt paid vs settled payments (F-13) ·
R-03 movement belongs to its owner's shift, not posted after close (F-19/F-20) · R-04 duplicate movements (F-19) · R-05a reversed expense without refund movement (F-22) · R-05b expense movement without an expense (F-17) · R-06 FX difference consistency (F-27) · R-07 expected-balance drift, information only (KD-06) · R-08 partner allocations never exceed the expense (D-09).

## 8. Applied migrations log (live database `posflowapp`)
| date | migration | applied by | verified |
|---|---|---|---|
| 2026-11-23 | `20261123070000` refund fix (KD-07) | owner, pasted in the Supabase SQL editor | md5 of `prosrc` equals the repo file after removing `\r` |
| 2026-11-23 | `20261123071000` FX debt crediting (KD-01) | same | same; R-06 returns 0 (no FX payments exist yet) |
| 2026-11-23 | `20261123072000` `post_shift_sale_atomic` (KD-06) | same | same; the function is unused until the app is switched |
| 2026-11-23 | `20261123073000` owner store reset fix (KD-08) | owner, pasted in the SQL editor | function present; the owner ran the reset path afterwards |
| 2026-11-23 | `20261123074000` partner expense rule (D-09) | owner, pasted in the SQL editor | `add_expense_atomic` carries the D-09 rule; `validate_partner_shares` carries the whole-percent and pool checks |
| 2026-11-23 | `20261123075000` partner withdrawals in any currency (D-10) | owner, pasted in the SQL editor | `partner_withdrawal_atomic` carries the D-10 rule (checked by md5 and marker in the live definition) |
| 2026-11-24 | `20261124080000` stock policy and free goods (D-14, F-11) | APPLIED by owner (SQL editor, no errors) | golden LAW-STOCK and LAW-FREE |
| 2026-11-24 | `20261124080100` cash sale with drawer, one transaction (D-11) | APPLIED by owner (SQL editor, no errors) | golden F1 |
| 2026-11-24 | `20261124080200` purchase edit: drawer link and supplier credit (D-13) | APPLIED by owner (SQL editor, no errors) | golden F8 |
| 2026-11-24 | `20261124080300` period closing: FX line (F4) | APPLIED by owner (SQL editor, no errors) | golden F4 |
| 2026-11-24 | `20261124080400` quick purchase on credit needs a supplier (F7) | APPLIED by owner (SQL editor, no errors) | golden F7 |
| 2026-11-24 | `20261124080500` cash quick purchase updates the drawer's expected balance cache | APPLIED by owner (SQL editor, "Success. No rows returned") | golden F7 (cache and replay checks) |
| 2026-11-24 | `20261124080600` sale date and time = the moment of sale (decision 2026-11-24: original sale time); a sale in a closed period keeps its posting time | APPLIED by owner (SQL editor, no errors) | golden ST |
| 2026-11-24 | `20261124080700` restaurant is a no-inventory store (sale never refuses for stock, never deducts; cost of goods is counted in profit, decision 2026-11-24) | APPLIED by owner (SQL editor) | golden RESTAURANT |
| 2026-11-24 | `20261124080800` re-audit fixes: N1 repeated purchase edit keeps the whole supplier credit (F-25), N2 drawer movement keeps 8 decimals (F-02), N3 received currency must match the sale value (F-06) | APPLIED by owner (SQL editor, via migration tool) and verified by a read of both function bodies | golden N1, N2, N3 |
| 2026-11-25 | `20261125090000` money precision (F-02): USD amounts and cached drawer/partner/customer balances keep 8 decimals in 12 functions (found: 5,000 LBP at 89,500 was stored as 0.06 USD); `_supplier_drawer_tx` in the repo now matches the live definition (a valid open shift is required) | APPLIED 2026-11-25 by the implementing agent after the owner's approval (migration tool, name `money_precision_8dp`; applied as a patch of each live definition with exact occurrence counts, so the repo file holds the readable full definitions) | md5 of `prosrc` of all 19 related functions on the live database equals the repo replay (13 changed as planned, 6 unchanged); no `anon` execute; golden PREC8 (9 checks; they fail without the migration) |
| 2026-11-25 | `20261125170000` M-3: a down payment on a credit sale is a real payment on the new debt (`debt_payments` row, operation id `<sale op>:down`), so `sum(debt_payments.settled_amount) = sum(debts.total_paid)`; only the debt block of `process_pos_sale_atomic` changed | APPLIED by QA with owner approval (Supabase `apply_migration`) | md5 of live `prosrc` = md5 of the repo body (`c316729991321463dd22644f07c85500`); golden M3 (10 cases) |
| 2026-11-25 | `20261125173000` one open shift per cashier (partial unique index `uq_cash_shifts_one_open_per_cashier` on `(user_id, COALESCE(cashier_id, user_id)) WHERE closed_at IS NULL`); the server refuses a second open shift, another cashier may keep their own | APPLIED by QA with owner approval; checked first: 0 stores had more than one open shift per cashier | index present in `pg_indexes`; golden SHIFT (5 cases) |
| 2026-11-26 | `20261126000000` refund allocation skips the `:down` debt_payments row (the sale-time down payment is the sale receipt, already refunded under receipt key `sale`) | APPLIED by QA with owner approval; live `prosrc` md5 `5177c1cef31860183c956fc4dae63d1d` = repo | golden M3 refund regression; live refund of a credit invoice with a down payment: 2 (sale) + 6 (later payment) = 8 |
| 2026-11-26 | `20261126010000` repo sync: `_credit_actor`, `issue_store_credit_atomic`, `apply_store_credit_to_debt_atomic`, `set_customer_credit_limit_atomic` existed only live (the repo file only mentioned them in a comment) | exact copy of live; applied (no-op, `_credit_actor` md5 `b8bcbe0e509c22caf441908812c56363` unchanged) | golden C12 (a database rebuilt from the repo now supports store credit) |
| 2026-11-26 | `20261126020000` paying a debt from store credit used a cash receipt with no shift and always failed; now a non-drawer receipt | APPLIED by QA with owner approval; live `prosrc` md5 `3c27b3b3574cd9e2669ac48ead1215f6` = repo | golden C12 (debt -20, credit 0, no drawer movement) |
| 2026-11-26 | `20261126030000` store credit at 8 decimals: `customer_credit_ledger.amount` numeric(18,4)→(20,8), balance view `customer_credit_balances` added to the repo (8 dp, security_invoker), issue/payout/apply round to 8 dp, apply compares at 8 dp | APPLIED with owner approval ("نفذ المهام كلها"); live hashes = repo | golden T2 (1.23456789 kept, payout leaves exactly 0, replays post once) |
| 2026-11-26 | `20261126040000` repo sync (non-financial): push-token tables/functions/triggers, `push_sent` flags, live `boss_activate_license` | not applied (idempotent, live already identical) | `npm run db:drift-sql -- --summary`: repo hashes = live for functions, columns, triggers, indexes |
| 2026-11-26 | `20261126050000` money columns at 8 decimals (debt_payments settled/fx/rounding, supplier ledger, purchase paid amounts, partner ledger deltas, purchase returns, credit limit; views recreated) and `record_debt_payment_atomic` at 8 decimals (a 0.05586592 payment was settled as 0.0559) | APPLIED with owner approval ("طبق الهجرة"); function hash = repo; 0 money columns below 8 decimals | golden P8DP |
| 2026-11-26 | `20261126060000` audit follow-up (external Gemini report, verified): server RPC `record_sale_profit_snapshot` (F-25/D-12: full original profit at 8 dp, once per invoice; the client direct insert stored 2 dp and only the down-payment share of a credit sale); `record_debt_payment_atomic` absorbs up to 0.05 USD (F-26, noted in rounding_adjustment); 4/2-dp USD rounding → 8 dp in expense, partner, purchase, write-off, partial-refund and refund-allocation functions (F-02) | APPLIED with owner approval ("صلحها"); live function hash = repo | golden SNAP, F26 |
| 2026-11-26 | `20261126070000` external review round 2 (D-28): FX vs rounding split in `record_debt_payment_atomic`; server-side original profit snapshot (deferred trigger) and refund-proof guard; `create_manual_debt_atomic` (F-25) | APPLIED with owner approval; live drift hashes = repo (fn 9af21fbc…) | golden R02, SNAP2, FXR, MDEBT |
| 2026-11-26 | `20261126080000` security phase 1: `revert_invoice_partner_profits_atomic` no longer callable by clients (any user could revert another store's partner profits by invoice id); `verify_user_pin` checks only the caller's own PIN, 5 failures lock 15 min (`pin_verify_attempts`); EXECUTE revoked from PUBLIC/anon on `create_manual_debt_atomic`, `record_sale_profit_snapshot`, `_owner_purge_allowed` | APPLIED with owner approval; live drift hashes = repo (fn 2d0efb13…) | golden SEC, R09 |
| 2026-11-26 | `20261126090000` security phase 2 + F-02: profile privilege-column guard (S-4), product-images 2 MB images only (S-8), e-mail lookup for owners/admins with a 30/10-min limit (S-6), USD 8 decimals in 10 remaining functions (D-30) | APPLIED with owner approval («طبق»); live drift hashes = repo (fn a03d13ca…) | golden SEC2, F02 |
| 2026-11-26 | `20261126160000` / `20261126161000` (external review): `settle_invoice_debts_atomic` and the historical-receipt replay check | APPLIED by Claude with owner approval | golden of that review |
| 2026-11-26 | `20261126170000` S-2 (D-32): guards against direct tampering with financial rows | APPLIED by the external agent (ChatGPT) per `docs/S2_APPLY_PLAN_FOR_AGENT.md`; live hashes = repo (fn ee609a9c…, trg 0db5db76…); live behaviour test by Claude: tampering refused, notes allowed (`docs/s2-verification/S2_LIVE_REPORT_AR.md`) | golden S2 (22) |
| 2026-11-26 | `20261126180000`: Arabic message for a missing invoice in `settle_invoice_debts_atomic`; UPDATE policy on product-images (own folder) so backup restore can overwrite | APPLIED with owner approval; live fn hash = repo (b1e01a34…) | golden SETTLE |
| 2026-11-26 | `20261126190000` `record_shift_movement_atomic` (D-33) | APPLIED with owner approval («بلّش بحركات الصندوق»); live fn hash = repo (78e971c6…); live probe: closed shift and expense type refused | golden MOVE |
| 2026-11-26 | `20261126200000` `open_cash_shift_atomic` (D-34, W-2) | APPLIED with owner approval («اكمل»); live fn hash = repo (b09daf6a…); live probe: open succeeded and rolled back, negative refused | golden OPEN |
| 2026-11-27 | `20261127100000` general store drawer (D-35), per-currency count | APPLIED with owner approval («موافق… بعد التعديلات»), live version `20261127024749`; 4 patched functions contain the change, anon cannot execute the RPCs; live probe in a rolled-back transaction: created 100 → open 30 → 70 → close 30 → 100, closing the general drawer refused, count 95 → shortage 5; nothing left behind; live R-01..R-08 = 0 (7 debts, 7 payments, 23 movements) | golden GENERAL (33 checks) |
| 2026-11-27 | `20261127110000` cashier permissions (D-36) | PENDING owner approval of the SQL | golden PERM |

Verify a function against the repo with `md5(replace(prosrc, E'\r', ''))` (a paste from Windows adds CRLF, which changes the plain md5 but not behaviour); signature, `SECURITY DEFINER` and `search_path` also matched. First live reconciliation after applying (R-01..R-06): 0 violations, but R-03/R-04/R-05b/R-06 checked 0 rows (no shifts yet) — repeat after the first real shift (open shift → cash sale → refund / debt payment).
These were not applied through the Supabase migration history table, so `supabase migration list` will not show them; the repository is the reference.

---

# Appendix B — formulas and worked examples (reference; subordinate to sections 0–6)

## B1. Sales totals (formulas 1.1 to 1.5 of the reference)

Symbols: `price` is unit price, `quantity` is quantity, `subtotal` is the sum of line totals, `discount` is an absolute discount value, `discount_percentage` is a percentage, `tax_rate` is a percentage.

- Line total: `line_total = price × quantity`.
- Absolute discount: `discounted_total = subtotal − discount`, and the implied percentage is `discount ÷ subtotal × 100`.
- Percentage discount: `discount_amount = subtotal × (discount_percentage ÷ 100)`.
- Exclusive tax, applied after discount: `tax_amount = (subtotal − discount) × (tax_rate ÷ 100)`, and `final_total = (subtotal − discount) + tax_amount`.

Worked example (from the reference): subtotal 600, discount 10% = 60, after discount 540, tax 5% on 540 = 27, final total 567.

Tax is calculated on the discounted amount. Calculating tax on the undiscounted subtotal is an error.

## B2. Tax-inclusive settlement mode (current system behavior)

The current system supports a tax-inclusive settlement mode recorded by `invoices.tax_inclusive` (introduced by migration `0004_sale_settlement_tax_inclusive.sql`). In that mode, received amounts already contain tax, so the net revenue used for profit is extracted by dividing by one plus the tax rate:

- Extraction factor: `f = 1 ÷ (1 + tax_rate ÷ 100)` when tax-inclusive is enabled and `tax_rate > 0`; otherwise `f = 1`.
- Stored invoice profit: `profit = round((subtotal − discount) × f − cogs, 8)`.
- Stored line profit: the line's net revenue (line amount minus its discount share) multiplied by `f`, minus the line cost, rounded to eight decimals.

The formulas reference does not describe this tax-inclusive mode. Use the executed logic for this mode and mention the gap in reports when the task touches profit.

## B3. Profit, margin, and cost of goods sold (formulas 2.1 to 2.5)

- Line profit before discount: `(sale_price − cost_price) × quantity`.
- Cost of goods sold: `COGS = Σ(cost_price × quantity)` across lines.
- Gross profit before discount: `Σ(sale_price × quantity) − COGS`.
- Margin on sale: `profit ÷ sale_price × 100`.
- Markup on cost: `profit ÷ cost_price × 100`.
- Discount allocation to lines: `line_discount = discount × (line_amount ÷ subtotal)`, guarded so the division is skipped when `subtotal` is zero.
- Net line profit (exclusive mode): `line_amount − line_discount − line_cost`.
- Net invoice profit (exclusive mode): `subtotal − discount − COGS`.

Discount handling: the discount is subtracted in full from revenue, so it reduces profit by its full amount, not by a ratio of profit. With tax-inclusive pricing: `net_revenue = (subtotal − discount) ÷ (1 + tax_rate/100)`, and `net_profit = net_revenue − COGS`. This matches the server implementation and the allocation in B3 above.

Worked example: subtotal 500, COGS 380 (gross profit 120). A discount of 50 gives net revenue 450 and net profit 70 (not 108).

## B4. Debts and settlements (formulas 3.1 to 3.3)

- Opening debt for a credit sale: `total_debt = final_total`, `total_paid = 0`, `remaining = total_debt`, `status = due`.
- Partial or full settlement: `new_total_paid = total_paid + payment`, `new_remaining = total_debt − new_total_paid`.
- Status rule: `remaining ≤ 0` gives `fully_paid`; `total_paid > 0` gives `partially_paid`; otherwise `due`.
- Settlement ratio for pending profit: `ratio = payment ÷ total_debt`.
- Confirmed portion of each pending profit entry: `confirmed = entry_amount × ratio`; the remainder stays pending. Confirmed profit increases the partner's balance and pending profit decreases by the same amount.

Worked example from the reference: a debt of 1000 settled by 300, 400, and 300 ends at remaining 0 and status `fully_paid`.

Reference caveat (important): section 3.3 and example 7.2 of the original reference compute each payment's ratio against the total debt independently. Taken literally, a profit of 200 on a 525 debt would show 123.8 confirmed after the second payment and only 200 in the final summary, which is internally inconsistent. The correct business rule is cumulative: after the debt is fully settled, the cumulative settled ratio is 100% and all pending profit must be confirmed. Verify the executed settlement code before relying on the per-payment formula, and report any discrepancy to the owner rather than changing the logic silently.

## B5. Partner distribution (formulas 4.1 to 4.4)

- Single partner: `share = total_profit × (percentage ÷ 100)`.
- Multiple partners: `share_i = total_profit × (percentage_i ÷ 100)`. The sum of percentages must not exceed 100 (server trigger `validate_partner_shares`); it is applied to the profit that remains after category partners are paid (F-21, D-07).
- Category-based distribution: specialist partners receive their category share first; the remaining profit is then distributed to general partners according to their percentages.
- Cash sales confirm profit immediately. Credit sales keep profit pending and confirm it in proportion to each payment (B4); the confirmed parts sum exactly to the pending profit and the final payment closes the remainder (F-12).

## B6. Refunds (formulas 5.1 and 5.2)

- Full refund reverses: inventory returns the sold quantity; cash-shift total decreases by the invoice total; profit decreases by the invoice profit; the customer's debt decreases by the invoice total.
- Partial refunds: the reference states that partial refunds were not supported at the time it was written. Verify the current refund code before relying on this behavior.
- Refunds follow the atomic and WAC rules in `AGENTS.md`: lock the records, reverse the old effect first, enforce stock ≥ 0, recalculate the weighted average cost, and keep history by status instead of deletion.

## B7. Rounding rules

- Do not round intermediate steps to two decimals. Carry eight decimals in USD and round for display only.
- When a discount split does not divide evenly, the rounding difference must be assigned deterministically (the reference suggests banker's rounding or assigning the residual to the last line). Follow the existing implementation; do not invent a new method.
- Display currency decimals follow F-02.

## B8. Tax pitfalls that must not regress

- Tax is calculated after discount (B1, F-07).
- Tax never increases profit. In exclusive mode profit excludes tax entirely. In tax-inclusive mode, profit uses the extraction factor in B2 (F-09).
- Tax on a discounted amount is not the same as a discount on a taxed amount; keep the order fixed.

## B9. Worked check for any change

Before changing any calculation, verify the change against at least one worked example from the reference and one example for each currency that the change affects. Record the expected values in the report. This is no longer enough on its own: every changed money rule also needs a case in a test that imports production code (gate G3, section 4).

## B10. Reference file

`FINANCIAL_FORMULAS_AR.md` is the complete original reference, preserved verbatim with its examples, tables, and sections (1 to 8). Load it only when the task needs a specific worked example or a section not summarized above.


## 9. Owner decisions and golden regressions of the QA round (2026-11-25)
- **D-15** A payment made at the moment of a credit sale is a payment on the debt, not a separate concept. It is stored in `debt_payments` (migration `20261125170000`), so `debts.total_paid` always equals the sum of its payments (F-13). Golden: `M3` in `supabase/tests/golden/scenarios.mjs` (`runQaFixes`).
- **D-16** The server decides whether a shift can open: one open shift per cashier (migration `20261125173000`). The client does not pre-check; if the server refuses, the device drops its local shift and adopts the open one (`CashShifts.tsx`, `openShiftCloud` returns `'conflict'`). Golden: `SHIFT` in `runQaFixes`.
- **D-17** A shift open in the cloud and unknown on this device is adopted when the shifts page loads; the expected cash is computed from the shift's cloud movements (F-18: opening + inflows − outflows, same type table as `close_cash_shift_atomic`), not from the cached `expected_balance`, which misses cash-sale movements (KD-06). Live check: opening 500, cash sale 2, debt payment 6 → 508 (cache said 506). Production test: `src/lib/__tests__/cashbox-shift-adopt.test.ts` (registered in `scripts/finance-check.mjs`).
- **G-12 fixed** (2026-11-26): the shift card and the closing preview now use one formula, `expectedCashOfShift` = opening + sales + deposits − expenses − withdrawals (the same as closing). The card used to drop deposits (a debt payment is a deposit): live case card 502 vs drawer detail 508. Golden: `G12` cases in `cashbox-shift-adopt.test.ts`.
- **J-10 verified, no bug** (2026-11-26): a partial refund is counted once. The invoice is rewritten to net values, the accounting ledger gets a negative event for the refunded part (revenue 13 − 5 = 8, realized 8 − 3 = 5) and the drawer one refund movement. Golden: `J10` (8 cases) in `runQaFixes`.
- **D-18** A queued shift open that the server refuses (unique violation, one open shift per cashier) is treated as handled and the local copy is dropped, so the device adopts the server's open shift instead of retrying forever (`dropRejectedShiftOpen`). Replaying the same shift id stays idempotent. Golden: `SHIFT` replay/refusal cases and `QUEUE` cases in `cashbox-shift-adopt.test.ts`.
- **D-19** The `:down` ledger row written by M-3 is the sale receipt, not a later payment: `_allocate_sales_refund` skips `operation_id LIKE '%:down'` so a refund never pays the down payment twice (migration `20261126000000`). Golden: refund regression inside `M3` in `runQaFixes`; verified live.
- **D-20** Store credit never touches the drawer when it pays a debt: `apply_store_credit_to_debt_atomic` records a non-drawer ('transfer') receipt with operation id `credit:<op>` and a matching `spend` ledger row (migration `20261126020000`). Found by plan C-12: before it, every attempt failed. Also found: four store-credit functions were live-only, now synced into the repo (`20261126010000`). Golden: `C12`.
- **D-21** Daily closing report (plan G-13): it now opens on the last day of the range (today), not the first; a reversed expense is no longer listed or summed in the day's expenses (the net already excluded it, so the card and the net disagreed: $7 listed, net unchanged); the label `reports.digitalSales` was shown as a raw key and is now translated in the five languages. Verified live on the screen against the database: 9 invoices $57.00 = cash $33 + credit $24, expenses 0, net $22.50 = realized profit.
- **D-22** (owner, 2026-11-26) Sales shown in every report and on the dashboard **include tax** (= `invoices.total`), like the daily closing; the tax report still shows sales without tax next to the tax, and profit is always net of tax (F-07). `invoiceGrossSales`, `ProfitDay.salesWithTax`. Verified live: summary, cashier report and daily close all show $57.00.
- **D-23** Store-credit actions use ONE operation id per user action (reused on retry) and are queued offline (`store_credit_op`); server refusals are not queued. `src/lib/store-credit-op.ts`, test `store-credit-op.test.ts`.
- **D-24** Local = cloud for the open shift: a shift closed in the cloud is closed on the device; when another session posted to the same shift and nothing is queued locally, the device reseeds its totals from the cloud movements (F-18) (`decideLocalShiftSync`). An expense reversed offline gives its cash back to the local drawer once (`drawer-expense-marks`). Reports read the cloud `is_reversed` flag (a reversed expense was counted in the expense total and net profit), and the P&L chart uses cloud figures instead of device-local profit records. Verified live: offline add+reverse of an expense → device 100 = cloud 100; two concurrent sessions → 2 invoices, distinct numbers, 2 drawer movements, stock −2.
- **D-25** (revised 2026-11-26 by the owner, back to F-20) An offline expense whose drawer shift was closed before it synced is NOT moved to another drawer and NOT recorded without a drawer automatically: it stays pending in the queue with its operation id, the user is told, and the owner reconciles it by hand. The server still refuses a closed shift (golden `CLOSEDQ`). Product movement now lists manual stock changes (restock/reset/opening) so the net movement explains the stock (live: 48 − 7 + 1 + 2 = 44).
- **D-26** (audit 2026-11-26) A device that never opened the shifts page sold cash with no local active shift while the cloud had one open, so the sale reached no drawer (live: invoices 20261125-00018..22 and 20261126-00027, $33, not in any drawer; test data, left as is). Now the device reconciles its drawer with the cloud after every cloud initialization (`reconcileDrawerWithCloud`, CloudSyncProvider) and again right before a cash sale when it has no active shift (2.5 s cap, the sale never waits longer). Verified live on a brand-new device: the next sale (20261126-00028) went to the open shift.
- **D-27** (audit follow-up) Stable operation id per user action also for in-shift currency exchange, supplier payment/refund and purchase return (F-20). A device transfer is refused while operations are still waiting in the sync queue (the transfer wipes local data). The unused direct `debts.delete()` helper was removed (F-25).
- **D-28** (external review, round 2) FX debt payments keep the rate difference (fx_difference_usd = cash − credit at the invoice rate) apart from the ≤ 0.05 snapping (rounding_adjustment = settlement − credit); R-06 checks fx = amount − settled + rounding. The original profit snapshot is written by the server when the sale commits (deferred trigger `invoice_profit_snapshot`); only rows with revenue ≥ 0 count as the snapshot, refund rows are negative. A manual debt is created by `create_manual_debt_atomic` (idempotent by client id, no drawer movement), never by a direct insert. R-02 subtracts what partial refunds returned from the paid part. Partner deposits/withdrawals and shift adoption keep 8 decimals (F-02). Migration `20261126070000`. Golden: `R02`, `SNAP2`, `FXR`, `MDEBT`.
- **D-29** (external recheck of `a46bf14`) A closed-shift offline expense (F-20) is parked as `errorClass: 'reconciliation'`: not retried, shown as «بانتظار المطابقة اليدوية» in stuck operations, until the owner acts. A manual debt the server refuses (closed period, invalid input) is shown to the user and never queued; a queued one that is refused becomes terminal. The device-transfer guard counts every unconfirmed operation (pending, sending, failed at any retry count) and stops if the queue cannot be read. Partner deposit/withdraw from the UI keep 8 decimals (F-02). R-09 also catches a linked credit quick purchase without its supplier-ledger entry; X-7b compares per stock location.
- **D-30** (function-by-function security/precision review, 2026-11-26) No other definer function lets a caller reach another store's rows (all fetch the target with `user_id = owner`). USD amounts left at 4 decimals in 10 functions (supplier payment/refund and their drawer movements, partner deposit and released profits, cash-sale drawer posting, purchase link/return/cancel, USD side of in-shift exchange) now keep 8 (F-02). Kept: counted cash at shift close, share percentages, foreign-currency amounts. Migration `20261126090000` (with security phase 2). Golden: `F02`, `SEC2`.
- **D-31** (owner decision 2026-11-26, F-05) A NEW money operation in a currency that is not set up is refused with a clear message («العملة … غير مفعّلة أو بلا سعر صرف»): the currency must be enabled in the store slots and have a rate the store entered (a fallback rate of 1 or a built-in default does not count). Applied at the user actions that write money: debt payment, expense, partner deposit/withdrawal, supplier payment/refund, store-credit payout. Not applied to display, to invoices converted with their own rate snapshot, or to replays of operations already accepted. The POS sale is not guarded: checkout offers only enabled currencies. Test: `currency-guard.test.ts`.
- **D-32** (S-2, owner-approved 2026-11-26, with the owner's conditions: users keep reading their data, owner/boss keep managing) Direct REST writes can no longer tamper with financial history (F-25). Drawer movements are append-only for clients and a new one must go to an open shift of the same store with amount > 0 (a closed shift is refused with (F-20), parked for manual reconciliation). Debts: no direct insert or change of amounts/status. Profit records: server-written only; a store manager may only mark one reversed. A closed shift is read-only; opening and closing figures change only through RPCs. A cashier cannot change invoice amounts/status, invoice lines or product cost. `receive_stock_wac` and `post_shift_sale_atomic` are internal. Guards are SECURITY INVOKER triggers that skip SECURITY DEFINER RPCs and service_role. Migration `20261126170000`. Golden: `S2`.
- **D-33** (direct-write migration step 1, owner-approved 2026-11-26) Drawer movements the app posts itself (cash sale without a server movement, digital sale, cash refund without a server movement, deposits) go through `record_shift_movement_atomic`, online and from the queue. Same behaviour as before (no financial change): one row per client id, a repeated sale reference is the same movement, other types keep reference#id, expected_balance untouched. New checks: same store, open shift (closed -> (F-20)), amount > 0, only app-posted types (server-owned types are refused). The direct insert stays open, guarded by S-2, for APKs already installed; close it once every device runs this release. Golden: `MOVE`.
- **D-34** (direct-write migration step 2 / W-2, 2026-11-26) Opening a shift goes through `open_cash_shift_atomic`, online and from the queue (`shift_open`, `cash_shift_upsert`). Same rules: client id = shift id, one open shift per cashier (unique index, 23505 -> the app adopts/drops as before). Deliberate difference: a replay of an existing id changes nothing (the old upsert reset opening/expected on a retry). New checks: cashier of the same store, opening >= 0, opened_at kept from the device but never in the future. Direct insert stays open (S-2 guarded) until W-1. Golden: `OPEN`.
- **D-35** (general store drawer, owner decision 2026-11-27) Each store has one permanent drawer (`cash_shifts.is_general`, created on first use by `ensure_general_drawer_atomic`, starting balance 0 or one the owner sets when it is created; cash added later is a `deposit_capital`). It is never closed. A cash operation without an open shift goes to it unless the owner requires a shift for that user (store sync settings `requireShiftCashier`, default on; `requireShiftOwner`, default off; client rule `decideCashDrawer`). When the store has a general drawer, server triggers move cash between it and the cashier shifts: a new shift's opening float leaves it (`transfer_out`, per currency, ref `shift_open:<id>:<ccy>`), a closed shift's COUNTED cash enters it (`transfer_in`, per currency, ref `shift_close:<id>:<ccy>`); the shift's surplus/shortage stays on the shift. Cash is never in both at once (it moves only at open/close). Optional count `count_general_drawer_atomic` (owner only, idempotent by operation id) posts the difference as surplus/shortage and keeps the drawer open. The always-open general drawer does not block currency changes and does not count as a cashier's open shift. Stores without a general drawer behave exactly as before. Golden: `GENERAL` (27 checks); production test `general-drawer.test.ts`.
- **D-36** (cashier permissions on the server, owner decision 2026-11-27) `products:add`: a member without it cannot insert/delete products or change any column except the stock fields (`quantity`, `archived`) that sales and stock counts write; `hard_delete_product_atomic` checks it. `purchases`: a member with it may read suppliers and finalize purchase invoices (`finalize_purchase_invoice_atomic` was owner-only). Owner/Boss unchanged. Helper `_caller_has_permission(key)` reads `profiles.allowed_pages` (a cashier cannot grant itself pages, SEC2). Golden: `PERM` (11 checks).
- **Plan sweep (verified, no deviation found):** golden cases now cover C-15 (fractional debt payments settle exactly), C-08 (transfer payment never touches the drawer), D-04 (taxed refund returns the tax), D-06 (outside-drawer refund posts no movement), D-07 (refund lands in the current shift), G-07/G-14 (shortage variance, no drift over 25 fractional movements), H-03/H-08/H-19 (partner shares, refund takes them back, fractional profits), I-01/I-15 (weighted average at 8 decimals), J-02 (expense in a closed period refused), I-14/I-09 (purchase return lowers stock; cancelling a paid purchase refunds into the chosen open shift; one with returns cannot be cancelled), C-10 (write-off moves no drawer money), C-11 (credit limit), H-05/H-06/H-07 (pending partner profit confirmed in proportion to payments, exact at the end), G-09 (two-currency close, -1 USD for a 15,000 SYP shortage). Live, from the UI: K-01/K-02 (offline cash sale syncs once: one invoice, one drawer movement, stock -1), K-03 (offline credit sale with a 2 down payment syncs once: one invoice, debt remaining 6, one payment row, one sale movement of 2), K-05 (offline expense then reversal: one expense movement and one refund movement, expense marked reversed). **Observed, not changed (needs the owner's decision):** the Reports screen shows total sales $56.62 for 9 invoices whose `invoices.total` adds to $57.00; the 0.38 difference is exactly the tax inside the tax-inclusive invoices (plan J-03 expects the sum of `total`). The law does not say whether the sales total is gross or net of tax. Checked on the screens (J-05/J-06/J-07): tax report $0.38 = `sum(tax_amount)`; debt aging $20 / 3 debts = active debts; debts report remaining $20, paid $12 = `sum(total_paid)`; cashier report cash $33 and credit $23.62 (net of tax). Inconsistency to decide: the Sales, Tax and Cashier reports show sales NET of tax ($56.62) while the Daily Closing report shows GROSS ($57.00) for the same day.
- **Reference result** (all measured on the live project after the fixes): live credit sale with a 2 USD down payment gave invoice `20261125-00016`: debt paid 2, remaining 6, one `debt_payments` row 2/2 cash, payments sum = debts paid sum. `finance:sql` 190/190 and `finance:check` green before the push.
- **Still open from the QA round** (not fixed, see the QA report): the shift close dialog and shift card show an expected balance that differs from the server (G-12, F-18 says the server value is right); the invoice number in the sale toast comes from a local counter; offline shift opens that the server later refuses are not yet reconciled by the queue.
