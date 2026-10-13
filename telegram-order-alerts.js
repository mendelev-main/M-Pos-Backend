export const ONLINE_ORDER_ALERT_TEXT = "Получен онлайн заказ проверьте POS";

const workDeviceChatId = value => /^\d{1,20}$/.test(String(value || "").trim());

export function createTelegramOrderAlerts({ query, botToken, fetchImpl = fetch }) {
  async function configure(deviceId, { chatId, ownerChatId, enabled }) {
    const normalizedChatId = String(chatId || "").trim();
    if (enabled && !workDeviceChatId(normalizedChatId)) {
      return { error: "Укажите корректный Telegram ID рабочего устройства", status: 400 };
    }
    const normalizedOwnerChatId = ownerChatId === undefined ? undefined : String(ownerChatId || "").trim();
    if (normalizedOwnerChatId !== undefined && normalizedOwnerChatId && !workDeviceChatId(normalizedOwnerChatId)) {
      return { error: "Укажите корректный Telegram ID владельца", status: 400 };
    }
    const storedChatId = workDeviceChatId(normalizedChatId) ? normalizedChatId : null;
    const fields = [
      "telegram_order_chat_id = $1",
      "notify_online_orders = $2",
    ];
    const params = [storedChatId, Boolean(enabled)];
    if (normalizedOwnerChatId !== undefined) {
      fields.push(`telegram_owner_chat_id = ${params.length + 1}`);
      params.push(normalizedOwnerChatId || null);
    }
    params.push(deviceId);
    await query(
      `UPDATE public.devices
       SET ${fields.join(", ")}
       WHERE id = ${params.length}::uuid`,
      params
    );
    return { ok: true, enabled: Boolean(enabled), chatId: storedChatId || "", ownerChatId: normalizedOwnerChatId || "" };
  }

  async function notifyNewOrder() {
    if (!botToken) return { sent: 0, skipped: "missing_bot_token" };
    const { rows } = await query(
      `SELECT telegram_order_chat_id
       FROM public.devices
       WHERE is_active = TRUE
         AND notify_online_orders = TRUE
         AND telegram_order_chat_id IS NOT NULL`
    );
    const chatIds = [...new Set((rows || []).map(row => String(row.telegram_order_chat_id || "").trim()).filter(workDeviceChatId))];
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
