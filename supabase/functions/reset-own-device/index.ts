import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, password } = await req.json().catch(() => ({} as any));

    if (!email || !password) {
      return json({ error: 'Email and password are required' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    // Create admin client for service operations
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Create anon client to verify credentials
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

    // Step 1: Verify credentials by attempting to sign in
    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError || !signInData.user) {
      console.log('[reset-own-device] Invalid credentials:', signInError?.message);
      return json({ error: 'بيانات الدخول غير صحيحة' }, 401);
    }

    const userId = signInData.user.id;
    console.log('[reset-own-device] Credentials verified for user:', userId);

    // Step 2: Reset through the guarded RPC only.
    // request_device_reset_secure owns the 5-day cooldown (Boss exempt),
    // the reset counter, and the device_id clearing. Never clear device_id here.
    const { data: result, error: rpcError } = await supabaseAdmin.rpc(
      'request_device_reset_secure',
      { p_user_id: userId }
    );

    // Sign out the temporary session we created for verification
    await supabaseAnon.auth.signOut();

    if (rpcError) {
      console.error('[reset-own-device] RPC failed:', rpcError.message);
      return json({ error: 'فشل في إعادة تعيين الجهاز' }, 500);
    }

    const outcome = (result ?? {}) as {
      success?: boolean;
      message?: string;
      error?: string;
      cooldown?: boolean;
      days_remaining?: number;
    };

    if (!outcome.success) {
      // Cooldown and policy rejections are returned verbatim so the UI can show them.
      const status = outcome.cooldown ? 429 : 400;
      return json(
        {
          error: outcome.error || 'فشل في إعادة تعيين الجهاز',
          cooldown: outcome.cooldown === true,
          days_remaining: outcome.days_remaining ?? null,
        },
        status
      );
    }

    console.log('[reset-own-device] Device reset approved for user:', userId);

    return json({
      success: true,
      message: outcome.message || 'تم إعادة تعيين الجهاز بنجاح. يمكنك الآن تسجيل الدخول.',
    });
  } catch (error) {
    console.error('[reset-own-device] Unexpected error:', error);
    return json({ error: 'حدث خطأ غير متوقع' }, 500);
  }
});
