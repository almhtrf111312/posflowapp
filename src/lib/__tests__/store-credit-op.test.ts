// Production-code test: store-credit operations keep ONE operation id across retries and the offline queue (plan T-1).
import { creditRpcCall, isNetworkFailure, submitCreditOperation, type CreditOpData } from '../store-credit-op';

let failed = 0;
let passed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) passed++;
  else { failed++; console.log(`FAIL ${name}: expected ${String(expected)} got ${String(actual)}`); }
}

// A fake queue with the same rule as addUniqueOperation: one entry per unique key.
function world(opts: { offline?: boolean; rpcError?: unknown; rpcThrows?: unknown } = {}) {
  const queue = new Map<string, CreditOpData>();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  let drawer = 0;
  const deps = {
    offline: () => !!opts.offline,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (opts.rpcThrows) throw opts.rpcThrows;
      return { error: opts.rpcError ?? null };
    },
    enqueue: (d: CreditOpData) => { if (!queue.has(d.operationId)) queue.set(d.operationId, d); },
    onLocalPayout: (d: CreditOpData) => { drawer -= d.amount; },
  };
  return { queue, calls, deps, drawer: () => drawer };
}

const OP = '11111111-2222-4333-8444-555555555555';
const payout: CreditOpData = { kind: 'payout', operationId: OP, amount: 1.23456789, customerId: 'c1', shiftId: 's1' };

(async () => {
  // Online: the RPC receives the caller's operation id, unchanged, on every attempt.
  {
    const w = world();
    await submitCreditOperation(payout, w.deps);
    await submitCreditOperation(payout, w.deps); // a retry after a lost reply
    eq('T1 online: the RPC is payout_store_credit_atomic', w.calls[0].fn, 'payout_store_credit_atomic');
    eq('T1 online: first attempt carries the caller operation id', w.calls[0].args._operation_id, OP);
    eq('T1 online: the retry carries the SAME operation id (server dedupes)', w.calls[1].args._operation_id, OP);
    eq('T1 online: amount keeps 8 decimals', w.calls[0].args._amount, 1.23456789);
  }
  // Offline: queued, not thrown; two taps queue ONE operation; local drawer moves once per submit.
  {
    const w = world({ offline: true });
    const r = await submitCreditOperation(payout, w.deps);
    await submitCreditOperation(payout, w.deps);
    eq('T1 offline: the operation is queued, not failed', r, 'queued');
    eq('T1 offline: two taps with the same id make one queued operation', w.queue.size, 1);
    eq('T1 offline: no RPC is attempted', w.calls.length, 0);
    eq('T1 offline: the queued operation keeps the operation id', w.queue.get(OP)?.operationId, OP);
  }
  {
    const w = world({ offline: true });
    await submitCreditOperation(payout, w.deps);
    eq('T1 payout: the local drawer mirror moves once by the amount', w.drawer(), -1.23456789);
  }
  // The request never reached the server → queued with the same id.
  {
    const w = world({ rpcThrows: new TypeError('Failed to fetch') });
    const r = await submitCreditOperation({ kind: 'apply', operationId: OP, amount: 2.5, debtId: 'd1' }, w.deps);
    eq('T1 network failure: queued', r, 'queued');
    eq('T1 network failure: queued once', w.queue.size, 1);
  }
  // A server refusal is NOT queued (it would retry a refused operation forever) and is reported.
  {
    const w = world({ rpcError: { code: 'P0001', message: 'رصيد العميل (0) أقل من المبلغ المطلوب' } });
    let thrown = false;
    try { await submitCreditOperation({ kind: 'apply', operationId: OP, amount: 2.5, debtId: 'd1' }, w.deps); } catch { thrown = true; }
    eq('T1 server refusal: reported to the user', thrown, true);
    eq('T1 server refusal: nothing queued', w.queue.size, 0);
  }
  // Mapping and validation.
  eq('T1 apply maps to apply_store_credit_to_debt_atomic', creditRpcCall({ kind: 'apply', operationId: OP, amount: 1, debtId: 'd' }).fn, 'apply_store_credit_to_debt_atomic');
  eq('T1 issue maps to issue_store_credit_atomic', creditRpcCall({ kind: 'issue', operationId: OP, amount: 1, customerId: 'c' }).fn, 'issue_store_credit_atomic');
  eq('T1 payout in LBP carries the rate 89500', creditRpcCall({ ...payout, amount: 1, currency: 'LBP', currencyAmount: 89500 }).args._rate, 89500);
  let noShift = false;
  try { creditRpcCall({ ...payout, shiftId: undefined }); } catch { noShift = true; }
  eq('T1 a cash payout without a shift is refused before queueing', noShift, true);
  let badId = false;
  try { creditRpcCall({ ...payout, operationId: 'x' }); } catch { badId = true; }
  eq('T1 a missing operation id is refused', badId, true);
  eq('T1 "Failed to fetch" is a network failure', isNetworkFailure(new TypeError('Failed to fetch')), true);
  eq('T1 a Postgres error is not a network failure', isNetworkFailure({ code: 'P0001', message: 'x' }), false);

  console.log(`Passed Cases: ${passed}`);
  console.log(`Failed Cases: ${failed}`);
  console.log(`${failed ? 'FAIL' : 'PASS'} store-credit-op: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
