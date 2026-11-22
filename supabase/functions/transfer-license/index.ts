import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, password } = await req.json().catch(() => ({}));

    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

    // 1. Verify credentials
    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email: String(email).trim(),
      password,
    });

    if (signInError || !signInData.user) {
      console.log('[transfer-license] Invalid credentials:', signInError?.message);
      return new Response(
        JSON.stringify({ error: 'كلمة المرور غير صحيحة' }),
        { status: 401, headers: jsonHeaders }
      );
    }

    const userId = signInData.user.id;

    // 2. Unbind the device through the same daily-limit RPC used by reset-own-device,
    //    so a device cannot be unbound more than once per day.
    const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc('request_device_reset_secure', {
      p_user_id: userId,
    });

    await supabaseAnon.auth.signOut();

    if (rpcErr || !rpcRes) {
      console.error('[transfer-license] RPC error:', rpcErr);
      return new Response(
        JSON.stringify({ error: 'فشل في فك ارتباط الجهاز' }),
        { status: 500, headers: jsonHeaders }
      );
    }

    if (!rpcRes.success) {
      return new Response(
        JSON.stringify({ success: false, error: rpcRes.error || 'لا يمكن تصفير الجهاز أكثر من مرة في اليوم' }),
        { status: 200, headers: jsonHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'تم فك ارتباط الجهاز بنجاح. يمكنك التفعيل من الجهاز الجديد.',
        reset_at: rpcRes.reset_at,
      }),
      { status: 200, headers: jsonHeaders }
    );
  } catch (error) {
    console.error('[transfer-license] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: 'حدث خطأ غير متوقع' }),
      { status: 500, headers: jsonHeaders }
    );
  }
});
