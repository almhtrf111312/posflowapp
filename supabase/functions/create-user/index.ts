import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const J = { ...corsHeaders, "Content-Type": "application/json" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Missing authorization header" }), { status: 401, headers: J });
    }
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await adminClient.auth.getUser(token);
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: J });
    }
    const currentUser = userData.user;

    const { data: currentUserRole, error: roleError } = await adminClient.from("user_roles").select("role").eq("user_id", currentUser.id).single();
    const isBoss = currentUserRole?.role === "boss";
    const isAdmin = currentUserRole?.role === "admin";
    if (roleError || (!isAdmin && !isBoss)) {
      return new Response(JSON.stringify({ error: "Only admins or boss can create users" }), { status: 403, headers: J });
    }

    const { email, password, fullName, role, userType, phone, allowedPages } = await req.json();
    if (!email || !password) {
      return new Response(JSON.stringify({ error: "Email and password are required" }), { status: 400, headers: J });
    }
    if (password.length < 6) {
      return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: J });
    }

    const normalizedEmail = (email || "").trim().toLowerCase();
    let normalizedPhone: string | null = null;
    if (phone && phone.trim()) {
      let clean = phone.trim().replace(/[^+0-9]/g, "");
      if (clean.startsWith("00")) clean = "+" + clean.slice(2);
      if (/^09[0-9]{8}$/.test(clean)) clean = "+963" + clean.slice(1);
      if (/^05[0-9]{9}$/.test(clean)) clean = "+90" + clean.slice(1);
      normalizedPhone = clean || null;
    }

    if (normalizedPhone) {
      const { data: existingProfile } = await adminClient.from("profiles").select("user_id, full_name, phone").eq("phone", normalizedPhone).maybeSingle();
      if (existingProfile) {
        return new Response(JSON.stringify({ error: `رقم الهاتف (${normalizedPhone}) مسجل بالفعل لحساب آخر ولا يمكن تكراره.` }), { status: 400, headers: J });
      }
    }

    const { data: existingUsers } = await adminClient.auth.admin.listUsers();
    const emailTaken = existingUsers?.users?.some((u) => u.email?.toLowerCase() === normalizedEmail);
    if (emailTaken) {
      return new Response(JSON.stringify({ error: "البريد الإلكتروني مسجل بالفعل لحساب آخر ولا يمكن استخدامه" }), { status: 400, headers: J });
    }

    const { data: newUser, error: createError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError) return new Response(JSON.stringify({ error: createError.message }), { status: 400, headers: J });
    if (!newUser?.user) return new Response(JSON.stringify({ error: "Failed to create user" }), { status: 500, headers: J });

    // حذف الدور الذي أنشأه الـ trigger تلقائياً قبل إدراج الدور الصحيح
    await adminClient.from("user_roles").delete().eq("user_id", newUser.user.id);

    let finalRole = role || "cashier";
    let ownerId: string | null = null;
    if (isBoss) {
      if (finalRole === "cashier") ownerId = currentUser.id;
    } else {
      finalRole = "cashier";
      ownerId = currentUser.id;
    }

    const { error: roleInsertError } = await adminClient.from("user_roles").insert({ user_id: newUser.user.id, role: finalRole, owner_id: ownerId });
    if (roleInsertError) {
      await adminClient.auth.admin.deleteUser(newUser.user.id);
      return new Response(JSON.stringify({ error: "Failed to assign role to user" }), { status: 500, headers: J });
    }

    const profileUpdate: { user_type?: string; phone?: string; allowed_pages?: unknown } = {};
    if (userType) profileUpdate.user_type = userType;
    if (normalizedPhone) profileUpdate.phone = normalizedPhone;
    if (allowedPages && Array.isArray(allowedPages)) profileUpdate.allowed_pages = allowedPages;
    if (Object.keys(profileUpdate).length > 0) {
      const { error: profileError } = await adminClient.from("profiles").update(profileUpdate).eq("user_id", newUser.user.id);
      if (profileError) console.error("Error updating profile:", profileError);
    }

    return new Response(JSON.stringify({ success: true, message: "User created successfully", user: { id: newUser.user.id, email: newUser.user.email } }), { status: 200, headers: J });
  } catch (error: unknown) {
    console.error("Error in create-user function:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: J });
  }
});
