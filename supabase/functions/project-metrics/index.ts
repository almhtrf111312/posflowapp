// Boss-only server metrics (CPU, memory, load) for the boss panel.
// DRAFT (2026-11-24): written, NOT deployed. Deploy needs owner approval.
// Needs the Edge Function secret POSFLOW_MANAGEMENT_TOKEN (a read-only Supabase access token for this project).
// Flow: verify boss -> read the project's secret API key with the access token -> scrape the project metrics endpoint.
// The secret API key and the access token never leave this function.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

// Keep only the series the boss panel shows; everything else is dropped.
const KEEP = /^(node_cpu_seconds_total|node_memory_MemTotal_bytes|node_memory_MemAvailable_bytes|node_load1|node_load5|node_load15|node_filesystem_avail_bytes|node_filesystem_size_bytes)(\{|\s)/

function pickSeries(prometheusText: string): string[] {
  return prometheusText.split('\n').filter((line) => line && !line.startsWith('#') && KEEP.test(line))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    // Same boss check as remote-activate-user
    const token = authHeader.replace('Bearer ', '')
    const { data: claims, error: claimsError } = await userClient.auth.getClaims(token)
    if (claimsError || !claims?.claims?.sub) return json({ error: 'Unauthorized' }, 401)

    const { data: roleData, error: roleError } = await userClient
      .from('user_roles')
      .select('role')
      .eq('user_id', claims.claims.sub)
      .maybeSingle()
    if (roleError || roleData?.role !== 'boss') return json({ error: 'Forbidden - Boss access required' }, 403)

    const managementToken = Deno.env.get('POSFLOW_MANAGEMENT_TOKEN')
    if (!managementToken) return json({ error: 'Metrics are not configured' }, 503)

    const projectRef = new URL(supabaseUrl).hostname.split('.')[0]

    // 1) Read the project's secret API key with the access token (never returned to the caller)
    const keysRes = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys?reveal=true`, {
      headers: { Authorization: `Bearer ${managementToken}` },
    })
    if (!keysRes.ok) {
      console.error('project-metrics: api-keys failed', keysRes.status)
      return json({ error: 'Could not read project keys' }, 502)
    }
    const keys: Array<{ name?: string; type?: string; api_key?: string }> = await keysRes.json()
    const secretKey = keys.find((k) => k.name === 'service_role' || k.type === 'secret')?.api_key
    if (!secretKey) return json({ error: 'Secret key not found' }, 502)

    // 2) Scrape the project metrics endpoint (Prometheus format, Basic auth)
    const metricsRes = await fetch(`https://${projectRef}.supabase.co/customer/v1/privileged/metrics`, {
      headers: { Authorization: 'Basic ' + btoa(`service_role:${secretKey}`) },
    })
    if (!metricsRes.ok) {
      console.error('project-metrics: metrics failed', metricsRes.status)
      return json({ error: 'Could not read metrics' }, 502)
    }
    const series = pickSeries(await metricsRes.text())

    return json({ fetchedAt: new Date().toISOString(), series })
  } catch (error) {
    console.error('project-metrics error:', error)
    return json({ error: 'Internal error' }, 500)
  }
})
