import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

function getCorsHeaders(_req: Request) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const FALLBACK_TRIAL_DAYS = 30;

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  const J = { ...corsHeaders, 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!

    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return new Response(JSON.stringify({ success: false, error: 'غير مصرح' }), { status: 401, headers: J })

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !user) return new Response(JSON.stringify({ success: false, error: 'غير مصرح' }), { status: 401, headers: J })

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    const { data: roleData, error: roleError } = await supabaseAdmin.from('user_roles').select('role, owner_id').eq('user_id', user.id).single()
    if (roleError || !roleData) return new Response(JSON.stringify({ success: false, error: 'لم يتم العثور على دور المستخدم' }), { status: 400, headers: J })
    if (roleData.role === 'cashier') return new Response(JSON.stringify({ success: false, error: 'الكاشير لا يمكنه بدء فترة تجريبية' }), { status: 403, headers: J })

    const { data: existingLicense } = await supabaseAdmin.from('app_licenses').select('id, is_trial, expires_at, is_revoked').eq('user_id', user.id).single()

    if (existingLicense) {
      const isExpired = new Date(existingLicense.expires_at) < new Date()
      if (!isExpired && !existingLicense.is_revoked) {
        return new Response(JSON.stringify({ success: true, message: 'لديك ترخيص صالح بالفعل', expiresAt: existingLicense.expires_at }), { status: 200, headers: J })
      }
      // A revoked license must never be re-activated through the trial endpoint
      if (existingLicense.is_revoked) {
        return new Response(JSON.stringify({ success: false, error: 'تم إلغاء ترخيص هذا الحساب، يرجى التواصل مع الإدارة' }), { status: 403, headers: J })
      }
      // Already used a trial (expired or not): no second trial
      if (existingLicense.is_trial) {
        return new Response(JSON.stringify({ success: false, error: 'لقد استخدمت الفترة التجريبية مسبقاً' }), { status: 400, headers: J })
      }
      // Expired paid license: renew it, do not restart a free trial
      return new Response(JSON.stringify({ success: false, error: 'انتهى اشتراكك، يرجى التجديد' }), { status: 403, headers: J })
    }

    let trialDays = FALLBACK_TRIAL_DAYS
    const { data: trialSetting } = await supabaseAdmin.from('app_settings').select('value').eq('key', 'default_trial_days').maybeSingle()
    const parsedTrialDays = parseInt(trialSetting?.value ?? '', 10)
    if (Number.isFinite(parsedTrialDays) && parsedTrialDays > 0 && parsedTrialDays <= 3650) trialDays = parsedTrialDays

    const trialExpiresAt = new Date()
    trialExpiresAt.setDate(trialExpiresAt.getDate() + trialDays)

    const licenseData = {
      user_id: user.id,
      expires_at: trialExpiresAt.toISOString(),
      is_trial: true,
      is_revoked: false,
      revoked_at: null,
      revoked_reason: null,
      max_cashiers: 1,
      license_tier: 'trial',
      activated_at: new Date().toISOString(),
      activation_code_id: null,
    }

    const { error } = await supabaseAdmin.from('app_licenses').insert(licenseData)
    if (error) return new Response(JSON.stringify({ success: false, error: 'حدث خطأ أثناء إنشاء الفترة التجريبية' }), { status: 500, headers: J })

    return new Response(JSON.stringify({ success: true, expiresAt: trialExpiresAt.toISOString(), daysRemaining: trialDays, isTrial: true }), { status: 200, headers: J })
  } catch (error) {
    console.error('Error starting trial:', error)
    return new Response(JSON.stringify({ success: false, error: 'حدث خطأ غير متوقع' }), { status: 500, headers: J })
  }
})
