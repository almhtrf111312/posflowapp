---
name: flowpos-financial-calculations
description: Consolidated, explained reference for every financial calculation in FlowPOS Pro, covering sales totals, discounts, tax, profit and margin, cost of goods sold, debts and partial settlements, pending and confirmed profit, partner distribution, refunds, rounding, and currency precision. Use whenever a task touches money, rates, totals, profit, debts, shifts, reports, or any [MONEY] line.
version: 2.0.0
---

# FlowPOS Pro — Financial Calculations (Consolidated Reference)

## 1. Purpose and authority

This skill collects every calculation rule used by FlowPOS Pro in one place and explains how each one applies. It merges the formulas that were previously stored as standalone calculation data.

Authority order for calculations:

1. The executed code and the stored SQL logic (for example the profit recalculation function in `drizzle/migrations/0004_sale_settlement_tax_inclusive.sql`, and the engine described as `money-engine.ts`).
2. The rules in this skill.
3. The complete original formulas reference, kept verbatim in `references/FINANCIAL_FORMULAS_AR_ORIGINAL.md`.

When a formula in the reference conflicts with executed code, the code is correct for the current system, and the conflict must be reported to the owner. The reference is never a reason to change working logic. Per the project rules, established formulas must never be changed unless the task identifies that formula as the root cause of a bug.

## 2. Non-negotiable money rules

1. **Base currency:** all stored and computed accounting values are in USD.
2. **Intermediate precision:** USD intermediate values keep eight decimal places. The engine and SQL both use eight-decimal rounding (`round(value, 8)`) for stored cost and profit values.
3. **Display precision:** each currency has its own display decimals defined by the currency catalog (0, 2, or 3 decimals). The project rules give IQD 0 decimals and USD 2 decimals as examples; confirm any other currency in the catalog before relying on it. Display rounding never changes stored values.
4. **Snapshots:** every invoice stores its exchange rate and currency symbol at creation (`CurrencySnapshot`). Historical invoices never recalculate from today's rate.
5. **No hardcoded currency:** never write `$`, `TRY`, `SYP`, or fixed fallback rates such as 32, 34, or 14500 into calculation code.
6. **Tax is not profit:** tax collected for the government is never counted as company profit or cost.
7. **Discount allocation:** a discount reduces revenue and profit proportionally across lines, as described in section 5.
8. **Negative and zero guards:** division by a zero subtotal must return zero (the SQL allocation uses a guard for `subtotal > 0`).
9. **Autonomous Calculator MCP Verification:** Whenever a task reviews, edits, or tests financial calculations, tax inclusive/exclusive extractions, discounts, or profit allocations, the agent MUST use the `accounting-calculator` MCP tool (`decimal.js` / `ROUND_HALF_UP`) to eliminate floating-point guessing and verify exact mathematical parity. Non-financial tasks (UI styling, navigation, button labels) automatically bypass this tool.

## 3. Sales totals (formulas 1.1 to 1.5 of the reference)

Symbols: `price` is unit price, `quantity` is quantity, `subtotal` is the sum of line totals, `discount` is an absolute discount value, `discount_percentage` is a percentage, `tax_rate` is a percentage.

- Line total: `line_total = price × quantity`.
- Absolute discount: `discounted_total = subtotal − discount`, and the implied percentage is `discount ÷ subtotal × 100`.
- Percentage discount: `discount_amount = subtotal × (discount_percentage ÷ 100)`.
- Exclusive tax, applied after discount: `tax_amount = (subtotal − discount) × (tax_rate ÷ 100)`, and `final_total = (subtotal − discount) + tax_amount`.

Worked example (from the reference): subtotal 600, discount 10% = 60, after discount 540, tax 5% on 540 = 27, final total 567.

Tax is calculated on the discounted amount. Calculating tax on the undiscounted subtotal is an error.

## 4. Tax-inclusive settlement mode (current system behavior)

The current system supports a tax-inclusive settlement mode recorded by `invoices.tax_inclusive` (introduced by migration `0004_sale_settlement_tax_inclusive.sql`). In that mode, received amounts already contain tax, so the net revenue used for profit is extracted by dividing by one plus the tax rate:

- Extraction factor: `f = 1 ÷ (1 + tax_rate ÷ 100)` when tax-inclusive is enabled and `tax_rate > 0`; otherwise `f = 1`.
- Stored invoice profit: `profit = round((subtotal − discount) × f − cogs, 8)`.
- Stored line profit: the line's net revenue (line amount minus its discount share) multiplied by `f`, minus the line cost, rounded to eight decimals.

The formulas reference does not describe this tax-inclusive mode. Use the executed logic for this mode and mention the gap in reports when the task touches profit.

## 5. Profit, margin, and cost of goods sold (formulas 2.1 to 2.5)

- Line profit before discount: `(sale_price − cost_price) × quantity`.
- Cost of goods sold: `COGS = Σ(cost_price × quantity)` across lines.
- Gross profit before discount: `Σ(sale_price × quantity) − COGS`.
- Margin on sale: `profit ÷ sale_price × 100`.
- Markup on cost: `profit ÷ cost_price × 100`.
- Discount allocation to lines: `line_discount = discount × (line_amount ÷ subtotal)`, guarded so the division is skipped when `subtotal` is zero.
- Net line profit (exclusive mode): `line_amount − line_discount − line_cost`.
- Net invoice profit (exclusive mode): `subtotal − discount − COGS`.

The reference shows two discount-impact models (2.3 and 2.4) that produce the same result: net profit equals gross profit multiplied by `discounted_total ÷ subtotal`, which is the same as subtracting the proportional share of the discount. The allocation in section 5 above matches the stored logic.

Worked example: products with profits 40, 40, and 40 give a gross profit of 120. A discount of 50 on a subtotal of 500 reduces profit by 12 (10%), leaving 108.

## 6. Debts and settlements (formulas 3.1 to 3.3)

- Opening debt for a credit sale: `total_debt = final_total`, `total_paid = 0`, `remaining = total_debt`, `status = due`.
- Partial or full settlement: `new_total_paid = total_paid + payment`, `new_remaining = total_debt − new_total_paid`.
- Status rule: `remaining ≤ 0` gives `fully_paid`; `total_paid > 0` gives `partially_paid`; otherwise `due`.
- Settlement ratio for pending profit: `ratio = payment ÷ total_debt`.
- Confirmed portion of each pending profit entry: `confirmed = entry_amount × ratio`; the remainder stays pending. Confirmed profit increases the partner's balance and pending profit decreases by the same amount.

Worked example from the reference: a debt of 1000 settled by 300, 400, and 300 ends at remaining 0 and status `fully_paid`.

Reference caveat (important): section 3.3 and example 7.2 of the original reference compute each payment's ratio against the total debt independently. Taken literally, a profit of 200 on a 525 debt would show 123.8 confirmed after the second payment and only 200 in the final summary, which is internally inconsistent. The correct business rule is cumulative: after the debt is fully settled, the cumulative settled ratio is 100% and all pending profit must be confirmed. Verify the executed settlement code before relying on the per-payment formula, and report any discrepancy to the owner rather than changing the logic silently.

## 7. Partner distribution (formulas 4.1 to 4.4)

- Single partner: `share = total_profit × (percentage ÷ 100)`.
- Multiple partners: `share_i = total_profit × (percentage_i ÷ 100)`. The sum of percentages must equal 100. Validate before saving.
- Category-based distribution: specialist partners receive their category share first; the remaining profit is then distributed to general partners according to their percentages.
- Cash sales confirm profit immediately. Credit sales keep profit pending until the debt is fully settled, then the pending amount becomes confirmed.

## 8. Refunds (formulas 5.1 and 5.2)

- Full refund reverses: inventory returns the sold quantity; cash-shift total decreases by the invoice total; profit decreases by the invoice profit; the customer's debt decreases by the invoice total.
- Partial refunds: the reference states that partial refunds were not supported at the time it was written. Verify the current refund code before relying on this behavior.
- Refunds follow the atomic and WAC rules in `PROJECT_RULES.md`: lock the records, reverse the old effect first, enforce stock ≥ 0, recalculate the weighted average cost, and keep history by status instead of deletion.

## 9. Rounding rules

- Do not round intermediate steps to two decimals. Carry eight decimals in USD and round for display only.
- When a discount split does not divide evenly, the rounding difference must be assigned deterministically (the reference suggests banker's rounding or assigning the residual to the last line). Follow the existing implementation; do not invent a new method.
- Display currency decimals follow section 2, rule 3.

## 10. Tax pitfalls that must not regress

- Tax is calculated after discount (section 3).
- Tax never increases profit. In exclusive mode profit excludes tax entirely. In tax-inclusive mode, profit uses the extraction factor in section 4.
- Tax on a discounted amount is not the same as a discount on a taxed amount; keep the order fixed.

## 11. Worked check for any change

Before changing any calculation, verify the change against at least one worked example from the reference and one example for each currency that the change affects. Record the expected values in the report. Do not add tests or scripts unless the owner asks, per the core workflow rule against experiments.

## 12. Reference file

`references/FINANCIAL_FORMULAS_AR_ORIGINAL.md` is the complete original reference, preserved verbatim with its examples, tables, and sections (1 to 8). Load it only when the task needs a specific worked example or a section not summarized above.
