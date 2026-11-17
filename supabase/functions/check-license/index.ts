import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Allowed origins for CORS
const allowedOrigins = [
  "capacitor://localhost",
  "http://localhost:5173",
  "http://localhost:8080",
];

function getCorsHeaders(_req: Request) {
  // التطبيق على أندرويد يرسل Origin = https://localhost وعلى ويندوز قد يكون مختلفاً،
  // والقائمة المحصورة كانت ترفضه فيظهر "Failed to send a request to the Edge Function".
  // الحماية الفعلية عبر توكن Authorization وليس عبر الـ Origin، فنسمح لكل الأصول مثل باقي الدوال.
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Create client with user's auth token
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

    // Validate JWT using getClaims first
    let requestBody: any = {};
    try {
      requestBody = await req.json();
    } catch (e) {}
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

    // Now verify user still exists in database
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();
    if (userError || !user) {
      // User doesn't exist anymore - tell client to sign out
      console.log("User from JWT does not exist:", userId);
      return new Response(JSON.stringify({ valid: false, error: "المستخدم غير موجود", userNotFound: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get user's role and owner_id
    const { data: roleData, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("role, owner_id, is_active")
      .eq("user_id", user.id)
      .single();

    if (roleError || !roleData) {
      console.log("No role found for user:", user.id);
      return new Response(
        JSON.stringify({
          valid: false,
          hasLicense: false,
          needsActivation: true,
          role: null,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Determine the owner_id for license check
    // If user is cashier, use their owner_id; otherwise use their own id
    const licenseOwnerId = roleData.role === "cashier" && roleData.owner_id ? roleData.owner_id : user.id;

    // IMPORTANT: Cashiers inherit license from owner - they don't need separate activation
    const isCashierWithOwner = roleData.role === "cashier" && roleData.owner_id;

    // Boss users always have valid license
    if (roleData.role === "boss") {
      return new Response(
        JSON.stringify({
          valid: true,
          hasLicense: true,
          isTrial: false,
          expiresAt: null,
          remainingDays: 999,
          needsActivation: false,
          role: "boss",
          isRevoked: false,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get owner's license (for both owners and their cashiers)
    const { data: license, error: licenseError } = await supabaseAdmin
      .from("app_licenses")
      .select("*")
      .eq("user_id", licenseOwnerId)
      .single();

    if (licenseError || !license) {
      // No license found
      // For cashiers, this means owner has no license - cashier should wait for owner to activate
      if (isCashierWithOwner) {
        return new Response(
          JSON.stringify({
            valid: false,
            hasLicense: false,
            needsActivation: false, // Cashier cannot activate - owner must do it
            ownerNeedsActivation: true,
            role: roleData.role,
            message: "صاحب الحساب لم يقم بتفعيل الترخيص بعد",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          valid: false,
          hasLicense: false,
          needsActivation: true,
          role: roleData.role,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Check device_id match
    // الكاشير يعمل على جهازه الخاص ويرث ترخيص المالك: لا يُقارن جهازه بجهاز المالك
    // اختلاف الجهاز ليس إلغاءً للترخيص: يُعاد deviceMismatch بدلاً من isRevoked حتى لا يُسجَّل خروج صاحب الحساب
    if (license.device_id && !license.allow_multi_device && !isCashierWithOwner) {
      if (!incomingDeviceId || license.device_id !== incomingDeviceId) {
        return new Response(
          JSON.stringify({
            valid: false,
            hasLicense: true,
            isRevoked: false,
            deviceMismatch: true,
            needsActivation: true,
            role: roleData.role,
            message: "هذا الترخيص مرتبط بجهاز آخر. تشغيل الحساب المستنسخ ممنوع.",
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }
    // Check if license is revoked
    if (license.is_revoked) {
      return new Response(
        JSON.stringify({
          valid: false,
          hasLicense: true,
          isRevoked: true,
          revokedAt: license.revoked_at,
          revokedReason: license.revoked_reason,
          needsActivation: true,
          role: roleData.role,
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
          valid: false,
          hasLicense: true,
          isExpired: true,
          isTrial: license.is_trial,
          needsActivation: true,
          expiredAt: license.expires_at,
          role: roleData.role,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Calculate remaining days
    const remainingMs = expiresAt.getTime() - now.getTime();
    const remainingDays = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

    // Check if cashier is active
    if (roleData.role === "cashier" && !roleData.is_active) {
      return new Response(
        JSON.stringify({
          valid: false,
          hasLicense: true,
          isCashierDisabled: true,
          needsActivation: false,
          role: roleData.role,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        valid: true,
        hasLicense: true,
        isTrial: license.is_trial === true,
        expiresAt: license.expires_at,
        remainingDays,
        needsActivation: false,
        role: roleData.role,
        maxCashiers: license.max_cashiers || 1,
        maxProducts: license.max_products !== null && license.max_products !== undefined ? license.max_products : 100,
        licenseTier: license.license_tier || "standard",
        planName: license.plan_name || (license.is_trial ? "فترة تجريبية" : "اشتراك مفعّل"),
        planAudience: license.plan_audience || license.license_tier || "standard",
        totalDays: license.total_days || 30,
        isRevoked: false,
        // Include warning if expiring soon (7 days)
        expiringWarning: remainingDays <= 7,
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

// redeploy: CORS fix for Android origin
