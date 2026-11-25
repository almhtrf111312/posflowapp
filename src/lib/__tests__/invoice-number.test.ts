// Production-code test: a local (not yet synced) invoice number is marked as provisional on screen.
import { isLocalInvoiceNumber, markIfProvisional } from '../invoice-number';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}

eq('INV local number is detected', isLocalInvoiceNumber('INV-2026-001'), true);
eq('INV local number with # is detected', isLocalInvoiceNumber('#INV-2026-017'), true);
eq('INV server number is not local', isLocalInvoiceNumber('20261125-00017'), false);
eq('INV empty is not local', isLocalInvoiceNumber(''), false);
eq('INV local number is marked in Arabic', markIfProvisional('#INV-2026-001', 'ar'), '#INV-2026-001 · رقم مؤقت');
eq('INV local number is marked in English', markIfProvisional('#INV-2026-001', 'en'), '#INV-2026-001 · provisional no.');
eq('INV unknown language falls back to Arabic', markIfProvisional('#INV-2026-001', 'xx'), '#INV-2026-001 · رقم مؤقت');
eq('INV a server number is never marked', markIfProvisional('#20261125-00017', 'ar'), '#20261125-00017');

console.log(`${failed ? 'FAIL' : 'PASS'} invoice-number: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
