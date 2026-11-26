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
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const adminClient = createClient(supabaseUrl, supabaseServiceKey)

    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await adminClient.auth.getUser(token)
    if (userError || !userData?.user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: J })
    const userId = userData.user.id

    const { data: roleData, error: roleError } = await adminClient.from('user_roles').select('role').eq('user_id', userId).maybeSingle()
    if (roleError || roleData?.role !== 'boss') return new Response(JSON.stringify({ error: 'Forbidden - Boss access required' }), { status: 403, headers: J })

    const { data: authUsers, error: authError } = await adminClient.auth.admin.listUsers({ perPage: 1000 })
    if (authError) return new Response(JSON.stringify({ error: 'Failed to fetch users' }), { status: 500, headers: J })

    const { data: profiles } = await adminClient.from('profiles').select('user_id, full_name, user_type')
    const { data: roles } = await adminClient.from('user_roles').select('user_id, role, owner_id, is_active, created_at')
    const { data: licenses } = await adminClient.from('app_licenses')
      .select('user_id, expires_at, is_revoked, license_tier, max_cashiers, device_id, allow_multi_device, is_trial, activation_code_id')
      .eq('is_revoked', false)
    const { data: activationCodes } = await adminClient.from('activation_codes').select('id, code')

    const codeMap = new Map((activationCodes || []).map((c) => [c.id, c.code]))
    const profileMap = new Map((profiles || []).map((p) => [p.user_id, p]))
    const roleMap = new Map((roles || []).map((r) => [r.user_id, r]))
    const licenseMap = new Map((licenses || []).map((l) => [l.user_id, l]))

    const cashierCounts = new Map<string, number>()
    for (const role of (roles || [])) {
      if (role.role === 'cashier' && role.owner_id && role.is_active) {
        cashierCounts.set(role.owner_id, (cashierCounts.get(role.owner_id) || 0) + 1)
      }
    }

    const usersWithDetails = authUsers.users.map((user) => {
      const profile = profileMap.get(user.id)
      const role = roleMap.get(user.id)
      const license = licenseMap.get(user.id)
      const activationCode = license?.activation_code_id ? codeMap.get(license.activation_code_id) : null
      return {
        user_id: user.id,
        email: user.email,
        full_name: profile?.full_name || null,
        user_type: profile?.user_type || null,
        role: role?.role || null,
        owner_id: role?.owner_id || null,
        is_active: role?.is_active ?? true,
        role_created_at: role?.created_at || user.created_at,
        license_expires: license?.expires_at || null,
        license_revoked: license?.is_revoked || false,
        license_tier: license?.license_tier || null,
        max_cashiers: license?.max_cashiers || null,
        device_id: license?.device_id || null,
        allow_multi_device: license?.allow_multi_device || false,
        is_trial: license?.is_trial || false,
        activation_code: activationCode || null,
        cashier_count: cashierCounts.get(user.id) || 0,
        created_at: user.created_at,
      }
    })

    const cashiersByOwner = new Map<string, Array<Record<string, unknown>>>()
    for (const user of usersWithDetails) {
      if (user.role === 'cashier' && user.owner_id) {
        const list = cashiersByOwner.get(user.owner_id) || []
        list.push({ user_id: user.user_id, email: user.email, full_name: user.full_name, user_type: user.user_type || 'cashier', is_active: user.is_active })
        cashiersByOwner.set(user.owner_id, list)
      }
    }

    const owners = usersWithDetails
      .filter((u) => u.role === 'admin' || u.role === 'boss')
      .map((owner) => ({ ...owner, cashiers: cashiersByOwner.get(owner.user_id) || [] }))

    return new Response(JSON.stringify({ users: owners }), { headers: J })
  } catch (error) {
    console.error('Unexpected error:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: J })
  }
})
