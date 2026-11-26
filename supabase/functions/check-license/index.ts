import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getCorsHeaders(_req: Request) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ valid: false, error: "غير مصرح", userNotFound: false }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    let requestBody: { device_id?: string } = {};
    try {
      requestBody = await req.json();
    } catch (_e) { /* no JSON body: no device id */ }
    const incomingDeviceId = requestBody.device_id;
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);

    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ valid: false, error: "غير مصرح", userNotFound: false }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub as string;

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      console.log("User from JWT does not exist:", userId);
      return new Response(JSON.stringify({ valid: false, error: "المستخدم غير موجود", userNotFound: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: roleData, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("role, owner_id, is_active")
      .eq("user_id", user.id)
      .single();

    if (roleError || !roleData) {
      console.log("No role found for user:", user.id);
      return new Response(
        JSON.stringify({ valid: false, hasLicense: false, needsActivation: true, role: null }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const licenseOwnerId = roleData.role === "cashier" && roleData.owner_id ? roleData.owner_id : user.id;
    const isCashierWithOwner = roleData.role === "cashier" && roleData.owner_id;

    if (roleData.role === "boss") {
      return new Response(
        JSON.stringify({
          valid: true, hasLicense: true, isTrial: false, expiresAt: null, remainingDays: 999,
          needsActivation: false, role: "boss", isRevoked: false,
          ownerHasPhone: true, hasPaidWriteAccess: true,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: ownerProfile } = await supabaseAdmin
      .from("profiles")
      .select("phone")
      .eq("user_id", licenseOwnerId)
      .maybeSingle();
    const ownerHasPhone = Boolean(ownerProfile?.phone && String(ownerProfile.phone).trim().length > 0);

    const { data: license, error: licenseError } = await supabaseAdmin
      .from("app_licenses")
      .select("*")
      .eq("user_id", licenseOwnerId)
      .single();

    if (licenseError || !license) {
      if (isCashierWithOwner) {
        return new Response(
          JSON.stringify({
            valid: false, hasLicense: false, needsActivation: false, ownerNeedsActivation: true,
            role: roleData.role, ownerHasPhone, hasPaidWriteAccess: false,
            message: "صاحب الحساب لم يقم بتفعيل الترخيص بعد",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          valid: false, hasLicense: false, needsActivation: true, role: roleData.role,
          ownerHasPhone, hasPaidWriteAccess: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (license.device_id && !license.allow_multi_device && !isCashierWithOwner) {
      if (!incomingDeviceId || license.device_id !== incomingDeviceId) {
        return new Response(
          JSON.stringify({
            valid: false, hasLicense: true, isRevoked: false, deviceMismatch: true, needsActivation: true,
            role: roleData.role, ownerHasPhone, hasPaidWriteAccess: false,
            message: "هذا الترخيص مرتبط بجهاز آخر. تشغيل الحساب المستنسخ ممنوع.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
    if (license.is_revoked) {
      return new Response(
        JSON.stringify({
          valid: false, hasLicense: true, isRevoked: true, revokedAt: license.revoked_at,
          revokedReason: license.revoked_reason, needsActivation: true, role: roleData.role,
          ownerHasPhone, hasPaidWriteAccess: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const now = new Date();
    const expiresAt = new Date(license.expires_at);
    const isExpired = expiresAt < now;

    if (isExpired) {
      return new Response(
        JSON.stringify({
          valid: false, hasLicense: true, isExpired: true, isTrial: license.is_trial, needsActivation: true,
          expiredAt: license.expires_at, role: roleData.role, ownerHasPhone, hasPaidWriteAccess: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const remainingMs = expiresAt.getTime() - now.getTime();
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

    if (roleData.role === "cashier" && !roleData.is_active) {
      return new Response(
        JSON.stringify({
          valid: false, hasLicense: true, isCashierDisabled: true, needsActivation: false, role: roleData.role,
          ownerHasPhone, hasPaidWriteAccess: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const isTrial = license.is_trial === true;
    const hasPaidWriteAccess = !isTrial || ownerHasPhone;

    return new Response(
      JSON.stringify({
        valid: true,
        hasLicense: true,
        isTrial,
        expiresAt: license.expires_at,
        remainingDays,
        needsActivation: false,
        role: roleData.role,
        maxCashiers: license.max_cashiers || 1,
        maxProducts: license.max_products !== null && license.max_products !== undefined ? license.max_products : 100,
        licenseTier: license.license_tier || "standard",
        planName: license.plan_name || (isTrial ? "فترة تجريبية" : "اشتراك مفعّل"),
        planAudience: license.plan_audience || license.license_tier || "standard",
        totalDays: license.total_days || 30,
        isRevoked: false,
        expiringWarning: remainingDays <= 7,
        ownerHasPhone,
        hasPaidWriteAccess,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(JSON.stringify({ valid: false, error: "حدث خطأ غير متوقع" }), {
      status: 500,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
  }
});
