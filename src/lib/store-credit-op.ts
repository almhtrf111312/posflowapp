// Store-credit operations (issue, pay a debt from credit, pay credit out in cash) with a STABLE operation id and an offline path.
// Pure: the RPC call, the queue and the local drawer are injected, so the rules are testable without the network.
// The operation id is created once by the caller and reused for every retry and for the queued replay; the server returns the
// first result for a repeated id, so a retry after a lost reply or a replay after reconnecting never posts twice (invariants 3–4).

export type CreditKind = 'issue' | 'apply' | 'payout';

export interface CreditOpData {
  kind: CreditKind;
  operationId: string;
  amount: number;              // USD, 8 decimals
  customerId?: string;         // issue, payout
  debtId?: string;             // apply
  reason?: string | null;      // issue
  invoiceNumber?: string | null; // issue
  shiftId?: string;            // payout (required)
  currency?: string;           // payout
  currencyAmount?: number;     // payout, amount in `currency`
}

export interface CreditOpDeps {
  offline: () => boolean;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;
  enqueue: (data: CreditOpData) => void;
  /** Local mirror of the drawer for a cash payout; called at most once per submit. */
  onLocalPayout?: (data: CreditOpData) => void;
}

export type CreditOpResult = 'done' | 'queued';

export const STORE_CREDIT_QUEUE_TYPE = 'store_credit_op' as const;

/** The single mapping from an operation to its server RPC; used by the online call and by the queue replay. */
export function creditRpcCall(d: CreditOpData): { fn: string; args: Record<string, unknown> } {
  if (!d.operationId || d.operationId.length < 8) throw new Error('معرّف العملية غير صالح');
  if (!(Number(d.amount) > 0)) throw new Error('المبلغ يجب أن يكون أكبر من الصفر');
  switch (d.kind) {
    case 'issue':
      return { fn: 'issue_store_credit_atomic', args: {
        _customer_id: d.customerId, _amount: d.amount, _reason: d.reason || null,
        _invoice_number: d.invoiceNumber || null, _operation_id: d.operationId,
      } };
    case 'apply':
      return { fn: 'apply_store_credit_to_debt_atomic', args: { _debt_id: d.debtId, _amount: d.amount, _operation_id: d.operationId } };
    case 'payout': {
      if (!d.shiftId) throw new Error('صرف الرصيد نقداً يتطلب وردية مفتوحة');
      const ccy = d.currency || 'USD';
      const ccyAmount = d.currencyAmount ?? d.amount;
      return { fn: 'payout_store_credit_atomic', args: {
        _customer_id: d.customerId, _amount: d.amount, _shift_id: d.shiftId, _operation_id: d.operationId,
        _currency: ccy, _currency_amount: ccyAmount, _rate: ccy !== 'USD' && d.amount > 0 ? ccyAmount / d.amount : null,
      } };
    }
  }
}

/** A failure that says nothing about the request reaching the server (no network). Business refusals are NOT network failures. */
export function isNetworkFailure(error: unknown): boolean {
  if (!error) return false;
  const e = error as { message?: unknown; code?: unknown; name?: unknown; status?: unknown };
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return false; // a Postgres error = the server answered
  const msg = String(e.message ?? error).toLowerCase();
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|timed out|err_internet_disconnected|err_network/.test(msg)
    || e.name === 'TypeError' && /fetch/.test(msg);
}

/**
 * Submit once. Offline (or the request never reached the server) → queued with the same operation id. A server refusal is thrown.
 * The local drawer mirror of a cash payout runs once, after success or after queueing.
 */
export async function submitCreditOperation(d: CreditOpData, deps: CreditOpDeps): Promise<CreditOpResult> {
  const call = creditRpcCall(d); // validates before anything is queued
  let result: CreditOpResult;
  if (deps.offline()) {
    deps.enqueue(d);
    result = 'queued';
  } else {
    let error: unknown = null;
    try { ({ error } = await deps.rpc(call.fn, call.args)); } catch (e) { error = e; }
    if (error && isNetworkFailure(error)) { deps.enqueue(d); result = 'queued'; }
    else if (error) throw error;
    else result = 'done';
  }
  if (d.kind === 'payout') deps.onLocalPayout?.(d);
  return result;
}
