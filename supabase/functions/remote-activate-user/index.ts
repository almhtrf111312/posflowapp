import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const J = { ...corsHeaders, 'Content-Type': 'application/json' }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: J })

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const userClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: authHeader } } })

    const token = authHeader.replace('Bearer ', '')
    const { data: claims, error: claimsError } = await userClient.auth.getClaims(token)
    if (claimsError || !claims?.claims?.sub) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: J })
    const bossId = claims.claims.sub

    const { data: roleData, error: roleError } = await userClient.from('user_roles').select('role').eq('user_id', bossId).maybeSingle()
    if (roleError || roleData?.role !== 'boss') return new Response(JSON.stringify({ error: 'Forbidden - Boss access required' }), { status: 403, headers: J })

    const body = await req.json()
    const { target_user_id, duration_days, max_cashiers = 1, license_tier = 'basic', activation_code_id = null } = body
    if (!target_user_id) return new Response(JSON.stringify({ error: 'target_user_id is required' }), { status: 400, headers: J })
    if (!duration_days && !activation_code_id) return new Response(JSON.stringify({ error: 'Either duration_days or activation_code_id is required' }), { status: 400, headers: J })

    const adminClient = createClient(supabaseUrl, supabaseServiceKey)
    let finalDurationDays = duration_days
    let finalMaxCashiers = max_cashiers
    let finalLicenseTier = license_tier
    const usedCodeId = activation_code_id

    if (activation_code_id) {
      const { data: codeData, error: codeError } = await adminClient.from('activation_codes').select('*').eq('id', activation_code_id).single()
      if (codeError || !codeData) return new Response(JSON.stringify({ error: 'Activation code not found' }), { status: 404, headers: J })
      if (!codeData.is_active) return new Response(JSON.stringify({ error: 'Activation code is not active' }), { status: 400, headers: J })
      if (codeData.current_uses >= codeData.max_uses) return new Response(JSON.stringify({ error: 'Activation code has reached maximum uses' }), { status: 400, headers: J })
      if (codeData.assigned_user_id && codeData.assigned_user_id !== target_user_id) {
        return new Response(JSON.stringify({ error: 'هذا الكود مخصص لحساب آخر' }), { status: 403, headers: J })
      }
      finalDurationDays = codeData.duration_days
      finalMaxCashiers = codeData.max_cashiers
      finalLicenseTier = codeData.license_tier
      await adminClient.from('activation_codes').update({
        current_uses: codeData.current_uses + 1,
        used_by: codeData.used_by || target_user_id,
        used_at: codeData.used_at || new Date().toISOString(),
      }).eq('id', activation_code_id)
    }

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + finalDurationDays)

    const { data: existingLicense } = await adminClient.from('app_licenses').select('id').eq('user_id', target_user_id).eq('is_revoked', false).maybeSingle()
    const fields = {
      expires_at: expiresAt.toISOString(),
      max_cashiers: finalMaxCashiers,
      license_tier: finalLicenseTier,
      activation_code_id: usedCodeId,
      is_trial: false,
      activated_at: new Date().toISOString(),
    }
    if (existingLicense) {
      const { error } = await adminClient.from('app_licenses').update(fields).eq('id', existingLicense.id)
      if (error) return new Response(JSON.stringify({ error: 'Failed to update license' }), { status: 500, headers: J })
    } else {
      const { error } = await adminClient.from('app_licenses').insert({ user_id: target_user_id, ...fields })
      if (error) return new Response(JSON.stringify({ error: 'Failed to create license' }), { status: 500, headers: J })
    }

    return new Response(JSON.stringify({
      success: true, expires_at: expiresAt.toISOString(), duration_days: finalDurationDays,
      max_cashiers: finalMaxCashiers, license_tier: finalLicenseTier,
    }), { headers: J })
  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: J })
  }
})
