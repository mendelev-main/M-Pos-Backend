export const VENUE_TIME_ZONE=process.env.VENUE_TIME_ZONE||"Europe/Minsk";
export const SITE_WAKE_MINUTE=6*60;
export const ORDER_OPEN_MINUTE=10*60;
export const ORDER_CLOSE_MINUTE=23*60;

export function venueMinute(date=new Date(),timeZone=VENUE_TIME_ZONE){
  const parts=new Intl.DateTimeFormat("en-GB",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date);
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return Number(values.hour)*60+Number(values.minute);
}

export function isSiteSleepWindow(date=new Date(),timeZone=VENUE_TIME_ZONE){return venueMinute(date,timeZone)<SITE_WAKE_MINUTE}
export function isOrderingOpen(date=new Date(),timeZone=VENUE_TIME_ZONE){const minute=venueMinute(date,timeZone);return minute>=ORDER_OPEN_MINUTE&&minute<ORDER_CLOSE_MINUTE}
export function millisecondsUntilSiteWake(date=new Date(),timeZone=VENUE_TIME_ZONE){return Math.max(60_000,(SITE_WAKE_MINUTE-venueMinute(date,timeZone))*60_000)}

export function closedPageHtml(){return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#08090b"><title>Проект временно закрыт</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#08090b;color:#f7f7f4;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif}.card{width:min(520px,100%);padding:34px;border:1px solid rgba(255,255,255,.1);border-radius:28px;background:#111318;text-align:center;box-shadow:0 30px 90px rgba(0,0,0,.35)}.brand{font-size:12px;font-weight:760;letter-spacing:.16em;text-transform:uppercase;color:#92979f}.clock{width:64px;height:64px;margin:26px auto 20px;border:1px solid rgba(255,255,255,.14);border-radius:50%;display:grid;place-items:center;font-size:28px}h1{margin:0;font-size:30px;letter-spacing:-.035em}p{margin:14px auto 0;max-width:380px;color:#a4a8af;font-size:16px;line-height:1.55}</style></head><body><main class="card"><div class="brand">Проект</div><div class="clock" aria-hidden="true">◷</div><h1>Ушли отдыхать, скоро вернемся</h1><p>Работаем с 10:00 до 23:00</p></main></body></html>`}
