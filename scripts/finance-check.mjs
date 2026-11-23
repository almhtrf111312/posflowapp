#!/usr/bin/env node
/**
 * FINANCE GATE (G1) — docs/FINANCE_LAW.md §5.
 *
 *   npm run finance:check
 *
 * Runs every registered financial test with tsx, fails on any non-zero exit or "FAIL" result, and refuses to pass
 * while an unclassified test file exists (so a new test cannot silently stay outside the gate).
 *
 * kind = 'production' → the test imports and runs real application code: valid evidence for the law.
 * kind = 'model'      → the test re-implements logic itself: proves the spec is consistent, NOT that production conforms (KD-02).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'src/lib/__tests__');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const REGISTERED = [
  { file: 'financial-precision.test.ts', kind: 'production', covers: 'money-engine: rounding, conversion, precise arithmetic' },
  { file: 'profit-engine.test.ts', kind: 'production', covers: 'profit-engine: realized/pending profit, write-offs, ranges' },
  { file: 'invoice-profit.test.ts', kind: 'production', covers: 'invoice-profit: invoice profit metrics' },
  { file: 'report-metrics.test.ts', kind: 'production', covers: 'report-metrics: net sales, revenue, unit cost, profit' },
  { file: 'pos-currency-scope.test.ts', kind: 'production', covers: 'POS currency scope: cart/catalog currency isolation' },
  { file: 'debt-fx.test.ts', kind: 'production', covers: 'debt-fx: foreign-currency debts credited at the invoice rate (F-27)' },
  { file: 'currency-symbols.test.ts', kind: 'production', covers: 'currency symbol resolution' },
  { file: 'comprehensive-accounting-audit.test.ts', kind: 'model', covers: 'accounting spec model (self-contained; see KD-02)' },
];
// Not financial: allowed to exist outside the gate. Anything else unlisted fails the gate.
const OUT_OF_SCOPE = [
  'export-semantics.test.ts', 'product-fields-defaults.test.ts', 'google-sign-in.test.ts',
  'remote-updates.test.ts', 'offline-lease-signature.test.ts', 'telegram-public-release.test.ts',
];

let red = false;
const problems = [];
const known = new Set([...REGISTERED.map((t) => t.file), ...OUT_OF_SCOPE]);
for (const f of fs.readdirSync(TEST_DIR).filter((n) => n.endsWith('.test.ts'))) {
  if (!known.has(f)) { red = true; problems.push(`unclassified test file: ${f} — add it to REGISTERED or OUT_OF_SCOPE in scripts/finance-check.mjs`); }
}

const rows = [];
let productionPass = 0, modelPass = 0;
for (const t of REGISTERED) {
  const file = path.join(TEST_DIR, t.file);
  if (!fs.existsSync(file)) { red = true; problems.push(`registered test missing: ${t.file}`); continue; }
  const r = spawnSync(process.execPath, [tsxCli, file], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const failedCases = Number((out.match(/Failed Cases:\s*(\d+)/) || [])[1] || 0);
  const failLines = out.split('\n').filter((l) => /^\s*(FAIL|✗|❌)\b/.test(l)).length;
  const passed = Number((out.match(/Passed Cases:\s*(\d+)/) || [])[1] || (out.match(/\bPASS\b/g) || []).length);
  const ok = r.status === 0 && failedCases === 0 && failLines === 0;
  if (!ok) {
    red = true;
    problems.push(`${t.file}: exit=${r.status} failedCases=${failedCases} failLines=${failLines}\n${out.split('\n').slice(-12).join('\n')}`);
  }
  if (t.kind === 'production') productionPass += passed; else modelPass += passed;
  rows.push(`${ok ? '✅' : '❌'} ${t.file.padEnd(42)} ${t.kind.padEnd(10)} ${String(passed).padStart(4)} passed   ${t.covers}`);
}

console.log('FINANCE GATE (G1)\n' + rows.join('\n'));
console.log(`\nEvidence against PRODUCTION code: ${productionPass} cases | model-only (not evidence): ${modelPass} cases`);
if (problems.length) console.error('\nPROBLEMS:\n' + problems.join('\n\n'));
console.log(red ? '\nFINANCE GATE: RED' : '\nFINANCE GATE: GREEN');
process.exit(red ? 1 : 0);
