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
