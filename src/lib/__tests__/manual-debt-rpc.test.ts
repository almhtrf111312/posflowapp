import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { ManualDebtRefusedError, submitManualDebt } from '../cloud/manual-debt-rpc';

async function run() {
  const requests: Array<{ url: string; args: Record<string, unknown> }> = [];
  const id = '55555555-5555-4555-8555-000000001111';
  const client = createClient<Database>('https://test.invalid', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: Object.assign(async (url: RequestInfo | URL, options?: RequestInit) => {
      const args = JSON.parse(String(options?.body));
      requests.push({ url: String(url), args });
      return args._total_debt > 0
        ? Response.json({ id: args._id, total_debt: args._total_debt })
        : Response.json({ code: 'P0001', message: 'المبلغ غير صالح' }, { status: 400 });
    }, { preconnect: fetch.preconnect }) },
  });
  const payload = { id, customer_name: 'Customer', total_debt: 12.12345678 };
  const debt = await submitManualDebt(client, payload);
  assert.equal(debt?.total_debt, payload.total_debt);
  assert.equal(requests[0].url, 'https://test.invalid/rest/v1/rpc/create_manual_debt_atomic');
  console.log('PASS submits exact debt amount through the installed Supabase client');
  await submitManualDebt(client, payload);
  assert.deepEqual(requests[1].args, requests[0].args);
  assert.equal(requests[1].args._id, id);
  console.log('PASS online and replay submit the same client debt ID');
  await assert.rejects(submitManualDebt(client, { ...payload, total_debt: 0 }), ManualDebtRefusedError);
  console.log('PASS a server refusal reaches the caller');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
