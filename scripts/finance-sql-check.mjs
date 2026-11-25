#!/usr/bin/env node
/**
 * FINANCE SQL GATE (part of G1) — docs/FINANCE_LAW.md §4.
 *
 *   npm run finance:sql
 *
 * Builds an in-memory PostgreSQL (PGlite) from supabase/migrations in the real applied order, runs the golden
 * scenarios (debts incl. foreign-currency, expenses, sale+refund, partner withdrawal, shift close) and then the
 * read-only reconciliation queries. It never touches a real database. Exit 1 on any FAIL.
 */
import { newWorld, kit } from '../supabase/tests/golden/world.mjs';
import { runScenarios, runExpenseShares, runPartnerCurrency, runLawFixes, runQaFixes } from '../supabase/tests/golden/scenarios.mjs';

const t0 = Date.now();
const w = await newWorld();
const k = kit();
try {
  await runScenarios(w, k);
  await runExpenseShares(k, () => newWorld());
  await runPartnerCurrency(k, () => newWorld());
  await runLawFixes(k, () => newWorld());
  await runQaFixes(k, () => newWorld());
} catch (e) {
  console.error('SCENARIO CRASH:', String(e.message).slice(0, 300), '|', String(e.where || '').slice(0, 200));
  process.exit(1);
}
const failed = k.results.filter((r) => !r.ok);
console.log(`\nFINANCE SQL GATE: ${k.results.length - failed.length}/${k.results.length} passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(failed.length ? 'FINANCE SQL GATE: RED' : 'FINANCE SQL GATE: GREEN');
process.exit(failed.length ? 1 : 0);
