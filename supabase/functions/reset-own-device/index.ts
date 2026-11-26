import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { email, password } = await req.json().catch(() => ({}));

    if (!email || !password) {
      return new Response(
        JSON.stringify({ success: false, error: 'البريد الإلكتروني وكلمة المرور مطلوبان' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
    const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey);

    // 1. التحقق الصارم من بيانات الدخول
    const { data: signInData, error: signInError } = await supabaseAnon.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError || !signInData.user) {
      return new Response(
        JSON.stringify({ success: false, error: 'كلمة المرور غير صحيحة، تعذر تصفير الجهاز' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = signInData.user.id;

    // 2. استدعاء دالة الـ SQL الآمنة الخاضعة لقيد اليوم الواحد
    const { data: rpcRes, error: rpcErr } = await supabaseAdmin.rpc('request_device_reset_secure', {
      p_user_id: userId
    });

    // تسجيل الخروج من جلسة التحقق المؤقتة
    await supabaseAnon.auth.signOut();

    if (rpcErr || !rpcRes) {
      console.error('[reset-own-device] RPC error:', rpcErr);
      return new Response(
        JSON.stringify({ success: false, error: 'تعذر تنفيذ عملية تصفير الجهاز في قاعدة البيانات' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // إذا أعادت الدالة خطأ عدم انقضاء مهلة اليوم الواحد
    if (!rpcRes.success) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: rpcRes.error || 'لا يمكن تصفير الجهاز أكثر من مرة في اليوم' 
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: 'تم فك ارتباط الجهاز السابق بنجاح. يمكنك الدخول الآن.',
        reset_at: rpcRes.reset_at
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error: unknown) {
    console.error('[reset-own-device] Fatal:', error);
    return new Response(
      JSON.stringify({ success: false, error: 'حدث خطأ داخلي في الخادم' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
