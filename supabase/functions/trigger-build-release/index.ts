import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

// «بناء ونشر» من لوحة المدير: يشغّل build-apk.yml على main مع publish_telegram=true.
// الـ workflow نفسه يرفع رقم الإصدار، يبني الـ APK، يزامن بيانات الإصدار، ثم يرسله لتيليجرام. للمدير العام فقط.
const GW = 'https://api.github.com';
const REPO = `repos/${Deno.env.get('GITHUB_REPO') ?? 'almhtrf111312/posflowapp'}`;
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const auth = req.headers.get('Authorization');
    if (!auth?.startsWith('Bearer ')) return json({ error: 'غير مصرح' }, 401);
    const url = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: 'جلسة غير صالحة' }, 401);
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: isBoss } = await admin.rpc('is_boss', { _user_id: user.id });
    if (!isBoss) return json({ error: 'للمدير العام فقط' }, 403);

    const GK = Deno.env.get('GITHUB_TOKEN');
    if (!GK) return json({ error: 'ربط GitHub غير مهيأ' }, 500);
    const gh = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${GW}/${REPO}/${path}`, {
        method,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${GK}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const t = await r.text();
      return { ok: r.ok, status: r.status, text: t };
    };

    let notes = '';
    try { const b = await req.json(); if (typeof b?.custom_notes === 'string') notes = b.custom_notes.slice(0, 2000); } catch { /* body optional */ }

    const run = await gh('POST', 'actions/workflows/build-apk.yml/dispatches', {
      ref: 'main',
      inputs: { publish_telegram: 'true', custom_notes: notes },
    });
    if (!run.ok) return json({ error: 'تعذر تشغيل البناء', status: run.status, details: run.text }, 502);
    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
