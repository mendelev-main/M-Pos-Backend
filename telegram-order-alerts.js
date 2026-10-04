export const ONLINE_ORDER_ALERT_TEXT = "Получен онлайн заказ проверьте POS";

const personalChatId = value => /^\d{1,20}$/.test(String(value || "").trim());

export function createTelegramOrderAlerts({ supabase, botToken, fetchImpl = fetch }) {
  async function configure(deviceId, { chatId, enabled }) {
    const normalizedChatId = String(chatId || "").trim();
    if (enabled && !personalChatId(normalizedChatId)) {
      return { error: "Укажите корректный личный Telegram ID", status: 400 };
    }
    const storedChatId = personalChatId(normalizedChatId) ? normalizedChatId : null;
    const { error } = await supabase.from("devices").update({
      telegram_order_chat_id: storedChatId,
      notify_online_orders: Boolean(enabled),
    }).eq("id", deviceId);
    if (error) throw error;
    return { ok: true, enabled: Boolean(enabled), chatId: storedChatId || "" };
  }

  async function notifyNewOrder() {
    if (!botToken) return { sent: 0, skipped: "missing_bot_token" };
    const { data, error } = await supabase.from("devices")
      .select("telegram_order_chat_id")
      .eq("is_active", true)
      .eq("notify_online_orders", true)
      .not("telegram_order_chat_id", "is", null);
    if (error) throw error;
    const chatIds = [...new Set((data || []).map(row => String(row.telegram_order_chat_id || "").trim()).filter(personalChatId))];
    const results = await Promise.allSettled(chatIds.map(async chatId => {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: ONLINE_ORDER_ALERT_TEXT }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    }));
    results.forEach(result => { if (result.status === "rejected") console.error("Telegram POS order alert:", result.reason); });
    return { sent: results.filter(result => result.status === "fulfilled").length, failed: results.filter(result => result.status === "rejected").length };
  }

  return { configure, notifyNewOrder };
}
