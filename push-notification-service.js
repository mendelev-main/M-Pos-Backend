import http2 from "node:http2";
import { createSign } from "node:crypto";

const RETRY_SECONDS = [5, 30, 120, 600, 1800];

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function createAPNSProvider(env = process.env) {
  const teamId = String(env.APNS_TEAM_ID || "").trim();
  const keyId = String(env.APNS_KEY_ID || "").trim();
  const bundleId = String(env.APNS_BUNDLE_ID || "com.prilavok.pos").trim();
  const privateKey = String(env.APNS_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  let cachedToken = "";
  let cachedAt = 0;

  function providerToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cachedToken && now - cachedAt < 50 * 60) return cachedToken;
    const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId }));
    const claims = base64url(JSON.stringify({ iss: teamId, iat: now }));
    const unsigned = `${header}.${claims}`;
    const signature = createSign("SHA256").update(unsigned).end().sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    cachedAt = now;
    cachedToken = `${unsigned}.${signature}`;
    return cachedToken;
  }

  async function send(token, environment, payload) {
    const origin = environment === "development" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
    return new Promise(resolve => {
      const client = http2.connect(origin);
      let settled = false;
      const finish = result => { if (settled) return; settled = true; client.close(); resolve(result); };
      client.setTimeout(15_000, () => { client.destroy(); finish({ ok: false, status: 0, reason: "timeout" }); });
      client.on("error", error => finish({ ok: false, status: 0, reason: error.message }));
      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${providerToken()}`,
        "apns-topic": bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
      });
      let status = 0;
      let body = "";
      request.setEncoding("utf8");
      request.on("response", headers => { status = Number(headers[":status"] || 0); });
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        let reason = "";
        try { reason = JSON.parse(body || "{}").reason || ""; } catch { reason = body.slice(0, 200); }
        finish({ ok: status === 200, status, reason });
      });
      request.on("error", error => finish({ ok: false, status: 0, reason: error.message }));
      request.end(JSON.stringify(payload));
    });
  }

  return { configured: Boolean(teamId && keyId && bundleId && privateKey), send };
}

export function createPushNotificationService({ supabase, provider = createAPNSProvider() }) {
  async function register(deviceId, body) {
    const token = String(body?.token || "").trim().toLowerCase();
    const environment = String(body?.environment || "").trim();
    const soundEnabled = body?.soundEnabled !== false;
    if (!/^[a-f0-9]{64,256}$/.test(token) || !["development", "production"].includes(environment)) {
      return { error: "Invalid push token", status: 400 };
    }
    const { error } = await supabase.rpc("register_device_push_token", {
      p_device_id: deviceId,
      p_token: token,
      p_environment: environment,
      p_sound_enabled: soundEnabled,
    });
    if (error) throw error;
    return { ok: true, configured: provider.configured };
  }

  async function reschedule(orderId, attempts, message) {
    const delay = RETRY_SECONDS[Math.min(RETRY_SECONDS.length - 1, Math.max(0, Number(attempts || 1) - 1))];
    const nextAttempt = new Date(Date.now() + delay * 1000).toISOString();
    const { error } = await supabase.from("order_push_outbox").update({ next_attempt_at: nextAttempt, last_error: String(message || "Push failed").slice(0, 500) }).eq("order_id", orderId).is("delivered_at", null);
    if (error) throw error;
  }

  async function drain(limit = 10) {
    if (!provider.configured) return { disabled: true, processed: 0 };
    const { data: jobs, error: claimError } = await supabase.rpc("claim_order_push_notifications", { p_limit: limit });
    if (claimError) throw claimError;
    let delivered = 0;
    for (const job of jobs || []) {
      const { data: tokens, error: tokensError } = await supabase.from("device_push_tokens").select("id,token,environment,sound_enabled,failure_count").eq("is_active", true);
      if (tokensError) throw tokensError;
      if (!tokens?.length) { await reschedule(job.order_id, job.attempts, "No active push token"); continue; }
      let sent = false;
      const title = "Новый онлайн-заказ";
      const body = [job.external_id, job.order_type].filter(Boolean).join(" · ");
      for (const target of tokens) {
        const aps = { alert: { title, body } };
        if (target.sound_enabled !== false) aps.sound = "default";
        const result = await provider.send(target.token, target.environment, { aps, kind: "web_order", orderId: job.order_id });
        if (result.ok) { sent = true; continue; }
        if (result.status === 410 || ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(result.reason)) {
          const { error } = await supabase.from("device_push_tokens").update({ is_active: false, failure_count: Number(target.failure_count || 0) + 1 }).eq("id", target.id);
          if (error) throw error;
        }
      }
      if (sent) {
        const { error } = await supabase.from("order_push_outbox").update({ delivered_at: new Date().toISOString(), last_error: null }).eq("order_id", job.order_id).is("delivered_at", null);
        if (error) throw error;
        delivered++;
      } else {
        await reschedule(job.order_id, job.attempts, "APNs delivery failed");
      }
    }
    return { disabled: false, processed: (jobs || []).length, delivered };
  }

  return { configured: provider.configured, register, drain };
}
