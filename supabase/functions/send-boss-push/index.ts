import { createClient } from "npm:@supabase/supabase-js@2";

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function accessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", typ: "JWT" });
  const claim = enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const pem = String(sa.private_key).replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claim}`));
  const jwt = `${head}.${claim}.${b64url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("oauth_failed: " + JSON.stringify(j));
  return j.access_token;
}

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Only the database triggers that hold the shared secret may call this function.
    const { data: secretOk } = await db.rpc("check_boss_push_secret", {
      p_secret: req.headers.get("x-push-secret") ?? "",
    });
    if (secretOk !== true) return json({ error: "unauthorized" }, 401);

    const { message_id, broadcast_id } = await req.json();

    const raw = Deno.env.get("FCM_SERVICE_ACCOUNT");
    if (!raw) return json({ error: "FCM_SERVICE_ACCOUNT missing" }, 500);
    const sa = JSON.parse(raw);

    let table: "boss_push_tokens" | "user_push_tokens" = "user_push_tokens";
    let userIds: string[] | null = null;
    let data: Record<string, string> = {};
    let onSent: (() => Promise<void>) | null = null;

    if (typeof message_id === "string" && message_id) {
      const { data: msg } = await db.from("support_messages")
        .update({ push_sent: true })
        .eq("id", message_id).eq("push_sent", false)
        .select("id, conversation_id, sender_role, message").maybeSingle();
      if (!msg) return json({ skipped: true });

      const { data: conv } = await db.from("support_conversations")
        .select("user_id, owner_id, user_name, store_name").eq("id", msg.conversation_id).maybeSingle();
      const isImage = String(msg.message || "").startsWith("[IMAGE]");
      const text = String(msg.message || "").replace(/\[IMAGE\][\s\S]*?\[\/IMAGE\]/, "").trim();
      const body = (text || (isImage ? "📷 صورة" : "")).slice(0, 120);
      onSent = async () => { await db.from("support_messages").update({ notified_native: true }).eq("id", msg.id); };

      if (msg.sender_role === "user") {
        table = "boss_push_tokens";
        const who = conv?.store_name || conv?.user_name || "عميل";
        data = { type: "chat", title: `📥 ${who}`, body, conversationId: String(msg.conversation_id) };
      } else {
        table = "user_push_tokens";
        userIds = [conv?.user_id, conv?.owner_id].filter((x, i, a) => !!x && a.indexOf(x) === i) as string[];
        if (!userIds.length) return json({ sent: 0 });
        data = { type: "support_reply", title: "💬 رد من الدعم الفني (PosFlow)", body, route: "/contact" };
      }
    } else if (typeof broadcast_id === "string" && broadcast_id) {
      const { data: b } = await db.from("app_broadcasts")
        .update({ push_sent: true })
        .eq("id", broadcast_id).eq("push_sent", false).eq("is_active", true)
        .select("id, title, body, kind, expires_at").maybeSingle();
      if (!b) return json({ skipped: true });
      if (b.expires_at && new Date(b.expires_at).getTime() < Date.now()) return json({ skipped: "expired" });
      data = {
        type: "broadcast",
        title: String(b.title || "POS Flow App").slice(0, 80),
        body: String(b.body || "").slice(0, 160),
        route: "/",
      };
    } else {
      return json({ error: "bad request" }, 400);
    }

    let q = db.from(table).select("token");
    if (userIds) q = q.in("user_id", userIds);
    const { data: tokens } = await q;
    if (!tokens?.length) return json({ sent: 0 });

    const at = await accessToken(sa);
    let sent = 0;
    const sendOne = async (token: string) => {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, data, android: { priority: "HIGH" } } }),
      });
      if (r.ok) { sent++; return; }
      const t = await r.text();
      if (t.includes("UNREGISTERED") || t.includes("NOT_FOUND") || t.includes("INVALID_ARGUMENT")) {
        await db.from(table).delete().eq("token", token);
      }
      console.error("fcm_error", r.status, t);
    };
    const list = tokens.map((t: { token: string }) => t.token);
    for (let i = 0; i < list.length; i += 25) {
      await Promise.all(list.slice(i, i + 25).map(sendOne));
    }
    if (sent > 0 && onSent) await onSent();
    return json({ sent, total: list.length });
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
