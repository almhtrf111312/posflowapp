import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const J = { ...corsHeaders, 'Content-Type': 'application/json' };

type DeleteType = 'user' | 'owner' | 'boss';
type SupabaseAnyClient = ReturnType<typeof createClient>;

async function safeDeleteByUserId(adminClient: SupabaseAnyClient, table: 'user_roles' | 'profiles' | 'app_licenses', userId: string) {
  const { error } = await adminClient.from(table).delete().eq('user_id', userId);
  if (error) console.error(`Error deleting from ${table}:`, error);
}

async function deleteAuthUser(adminClient: SupabaseAnyClient, userId: string) {
  const { error } = await adminClient.auth.admin.deleteUser(userId);
  if (error) throw error;
}

async function deleteUserCompletely(adminClient: SupabaseAnyClient, userId: string) {
  await safeDeleteByUserId(adminClient, 'app_licenses', userId);
  await safeDeleteByUserId(adminClient, 'profiles', userId);
  await safeDeleteByUserId(adminClient, 'user_roles', userId);
  await deleteAuthUser(adminClient, userId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response('ok', { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), { status: 401, headers: J });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || '';
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: J });
    }
    const currentUser = userData.user;

    const { data: currentUserRole, error: roleError } = await adminClient.from("user_roles").select("role").eq("user_id", currentUser.id).single();
    const isBoss = currentUserRole?.role === "boss";
    const isAdmin = currentUserRole?.role === "admin";
    if (roleError || (!isAdmin && !isBoss)) {
      return new Response(JSON.stringify({ error: "Only admins or boss can delete users" }), { status: 403, headers: J });
    }

    const { userId, deleteType } = await req.json() as { userId?: string; deleteType?: DeleteType };
    if (!userId) return new Response(JSON.stringify({ error: "User ID is required" }), { status: 400, headers: J });
    if (userId === currentUser.id) return new Response(JSON.stringify({ error: "Cannot delete your own account" }), { status: 400, headers: J });

    const { data: targetRoleRow, error: targetRoleErr } = await adminClient.from('user_roles').select('role, owner_id').eq('user_id', userId).maybeSingle();
    if (targetRoleErr) {
      return new Response(JSON.stringify({ success: false, error: 'Failed to read target role' }), { status: 500, headers: J });
    }
    const targetRole = targetRoleRow?.role as string | undefined;
    const targetOwnerId = (targetRoleRow as { owner_id?: string | null } | null)?.owner_id as string | null | undefined;

    if (deleteType === 'boss') {
      if (!isBoss) return new Response(JSON.stringify({ success: false, error: 'Only boss can delete other boss accounts' }), { status: 403, headers: J });
      if (targetRole !== 'boss') return new Response(JSON.stringify({ success: false, error: 'Target user is not a boss' }), { status: 400, headers: J });
    }
    if (deleteType === 'owner') {
      if (!isBoss) return new Response(JSON.stringify({ success: false, error: 'Only boss can delete owner accounts' }), { status: 403, headers: J });
      if (targetRole === 'boss') return new Response(JSON.stringify({ success: false, error: 'Cannot delete a boss account using owner deletion' }), { status: 400, headers: J });
    }
    if (isAdmin && !isBoss) {
      if (!targetRoleRow) return new Response(JSON.stringify({ success: false, error: 'Target user not found' }), { status: 404, headers: J });
      if (targetRole !== 'cashier') return new Response(JSON.stringify({ success: false, error: 'Admins can only delete cashier accounts' }), { status: 403, headers: J });
      if (targetOwnerId !== currentUser.id) return new Response(JSON.stringify({ success: false, error: 'Cannot delete users outside your ownership' }), { status: 403, headers: J });
    }

    if (deleteType === 'owner') {
      const { data: subRoles, error: subErr } = await adminClient.from('user_roles').select('user_id').eq('owner_id', userId);
      if (subErr) return new Response(JSON.stringify({ success: false, error: 'Failed to fetch sub accounts' }), { status: 500, headers: J });
      const subUserIds = (subRoles || []).map((r: { user_id: string }) => r.user_id).filter((id: string) => id && id !== userId);

      // 1) Purge ALL business data first (atomic, runs as the boss JWT). If it fails we stop here and delete nothing,
      //    otherwise the data would stay orphaned on Supabase.
      if (!supabaseAnonKey) {
        return new Response(JSON.stringify({ success: false, error: 'Server configuration error (anon key missing)' }), { status: 500, headers: J });
      }
      const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: cascadeOk, error: cascadeErr } = await authedClient.rpc('delete_owner_cascade', { _owner_id: userId });
      if (cascadeErr || cascadeOk !== true) {
        console.error('delete_owner_cascade failed:', cascadeErr, cascadeOk);
        return new Response(JSON.stringify({ success: false, error: 'تعذر حذف بيانات الحساب، لم يُحذف أي شيء', details: cascadeErr?.message ?? 'cascade returned false' }), { status: 500, headers: J });
      }

      // 2) Then the auth users (cashiers first, owner last)
      for (const subId of subUserIds) {
        try { await deleteUserCompletely(adminClient, subId); } catch (e) { console.error('Failed deleting sub account:', subId, e); }
      }
      await deleteUserCompletely(adminClient, userId);
      return new Response(JSON.stringify({ success: true, message: 'Owner deleted completely' }), { status: 200, headers: J });
    }

    await deleteUserCompletely(adminClient, userId);
    return new Response(JSON.stringify({ success: true, message: "User deleted successfully" }), { status: 200, headers: J });
  } catch (error: unknown) {
    console.error("Error in delete-user function:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: J });
  }
});
