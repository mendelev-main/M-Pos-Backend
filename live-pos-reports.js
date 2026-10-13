const telegramIdPattern = /^\d{1,20}$/;
const requestIdPattern = /^[A-Za-z0-9_-]{20,100}$/;

function serviceError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function text(value, limit = 120) {
  return String(value || "").trim().slice(0, limit);
}

function rows(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map(row => ({
    name: text(row?.name, 120) || "Без названия",
    quantity: Math.max(0, finite(row?.quantity)),
    revenue: Math.max(0, finite(row?.revenue)),
  }));
}

export function sanitizeLivePosReport(value) {
  const report = value && typeof value === "object" ? value : {};
  const shiftOpen = report.shiftOpen === true;
  return {
    generatedAt: Math.max(0, finite(report.generatedAt)) || Date.now(),
    shiftOpen,
    shiftOpenedAt: shiftOpen ? Math.max(0, finite(report.shiftOpenedAt)) : 0,
    employeeName: shiftOpen ? text(report.employeeName) : "",
    currency: text(report.currency, 12) || "BYN",
    orders: shiftOpen ? Math.max(0, Math.trunc(finite(report.orders))) : 0,
    revenue: shiftOpen ? Math.max(0, finite(report.revenue)) : 0,
    cash: shiftOpen ? Math.max(0, finite(report.cash)) : 0,
    card: shiftOpen ? Math.max(0, finite(report.card)) : 0,
    categories: shiftOpen ? rows(report.categories) : [],
    products: shiftOpen ? rows(report.products) : [],
  };
}

export function createLivePosReports({ query, createId, timeoutMs = 8000 }) {
  const pending = new Map();

  async function ownerDevice(telegramId) {
    const normalized = String(telegramId || "").trim();
    if (!telegramIdPattern.test(normalized)) throw serviceError("Доступ запрещён", 403, "OWNER_FORBIDDEN");
    const { rows } = await query(
      `SELECT id
       FROM public.devices
       WHERE is_active = TRUE
         AND telegram_owner_chat_id = $1
       LIMIT 1`,
      [normalized]
    );
    const device = rows?.[0];
    if (!device) throw serviceError("Доступ запрещён", 403, "OWNER_FORBIDDEN");
    return device;
  }

  async function access(telegramId) {
    await ownerDevice(telegramId);
    return { ok: true };
  }

  async function request(telegramId, deliver) {
    const device = await ownerDevice(telegramId);
    const requestId = createId();
    if (!requestIdPattern.test(requestId)) throw new Error("Invalid live report request ID");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(serviceError("POS не активен", 409, "POS_OFFLINE"));
      }, timeoutMs);
      pending.set(requestId, { deviceId: device.id, resolve, timer });
      if (!deliver(device.id, { type: "owner_live_report_request", requestId })) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(serviceError("POS не активен", 409, "POS_OFFLINE"));
      }
    });
  }

  function submit(deviceId, requestId, report) {
    if (!requestIdPattern.test(String(requestId || ""))) return false;
    const entry = pending.get(requestId);
    if (!entry || entry.deviceId !== deviceId) return false;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve({ ok: true, report: sanitizeLivePosReport(report) });
    return true;
  }

  return { access, request, submit };
}
