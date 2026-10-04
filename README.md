import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 3000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "prilavok-backend" });
});


app.post("/api/menu/sync", async (req, res) => {
  try {
    const deviceKey = String(req.header("x-device-key") || req.body?.deviceKey || "").trim();
    const deviceName = String(req.body?.deviceName || "Прилавок iPad").trim();
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const products = Array.isArray(req.body?.products) ? req.body.products : [];

    if (!deviceKey) {
      return res.status(401).json({ error: "Missing device key" });
    }

    // Register/update the POS device. The key is generated and stored locally on the iPad.
    const { data: device, error: deviceError } = await supabase
      .from("devices")
      .upsert(
        { device_key: deviceKey, name: deviceName || "Прилавок iPad", is_active: true, last_sync_at: new Date().toISOString() },
        { onConflict: "device_key" }
      )
      .select("id")
      .single();

    if (deviceError) throw deviceError;

    const categoryRows = categories
      .map((c, index) => ({
        external_id: String(c.externalId || `category:${String(c.name || "").trim()}`),
        name: String(c.name || "").trim(),
        color: c.color ? String(c.color) : null,
        sort_order: Number.isFinite(Number(c.sortOrder)) ? Number(c.sortOrder) : index,
        is_active: true
      }))
      .filter(c => c.name && c.external_id);

    if (categoryRows.length) {
      const { error } = await supabase
        .from("categories")
        .upsert(categoryRows, { onConflict: "external_id" });
      if (error) throw error;
    }

    const externalIds = categoryRows.map(c => c.external_id);
    let categoryMap = new Map();

    if (externalIds.length) {
      const { data: dbCategories, error } = await supabase
        .from("categories")
        .select("id,external_id")
        .in("external_id", externalIds);
      if (error) throw error;
      for (const c of dbCategories || []) categoryMap.set(c.external_id, c.id);
    }

    const productRows = products
      .map((p, index) => {
        const categoryName = String(p.category || "Без категории").trim() || "Без категории";
        const categoryExternalId = `category:${categoryName}`;
        return {
          external_id: String(p.externalId || ""),
          name: String(p.name || "").trim(),
          description: p.description ? String(p.description) : null,
          price: Number(p.price || 0),
          category_id: categoryMap.get(categoryExternalId) || null,
          sort_order: Number.isFinite(Number(p.sortOrder)) ? Number(p.sortOrder) : index,
          is_active: p.isActive !== false,
          available_online: p.availableOnline !== false,
          visible_in_menu: p.visibleInOnlineMenu !== false
        };
      })
      .filter(p => p.external_id && p.name);

    if (productRows.length) {
      const { error } = await supabase
        .from("products")
        .upsert(productRows, { onConflict: "external_id" });
      if (error) throw error;
    }

    return res.json({
      ok: true,
      deviceId: device?.id || null,
      categories: categoryRows.length,
      products: productRows.length,
      syncedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error("POST /api/menu/sync:", error);
    return res.status(500).json({
      error: "Failed to sync menu"
    });
  }
});

app.get("/api/menu", async (_req, res) => {
  try {
    const { data: categories, error: categoriesError } = await supabase
      .from("categories")
      .select("id,name,color,sort_order,is_active,external_id")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (categoriesError) throw categoriesError;

    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id,name,description,price,category_id,image_url,sort_order,is_active,available_online,external_id")
      .eq("is_active", true)
      .eq("available_online", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (productsError) throw productsError;

    res.json({
      categories: categories ?? [],
      products: products ?? []
    });
  } catch (error) {
    console.error("GET /api/menu:", error);
    res.status(500).json({
      error: "Failed to load menu"
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Prilavok backend listening on port ${port}`);
});

## Доступность товаров для WEB-заказа

POS остаётся источником физического остатка. После успешной локальной операции он в фоне отправляет
полный snapshot через `POST /api/availability/snapshot`; продажа на iPad не ждёт сеть и не откатывается
при её ошибке. Регулярного availability heartbeat и автоматической синхронизации каталога нет.

Backend хранит snapshot отдельно от резервов подтверждённых WEB-заказов. `GET /api/menu` возвращает
для каждого товара `availability_known` и `available_quantity`. Сайт ограничивает карточки и корзину
при загрузке, при открытии корзины и перед checkout. Это ранняя проверка для интерфейса; окончательная
защита выполняется при подтверждении телефона: создание заказа и резерв количества проходят одной
транзакцией. Если snapshot отсутствует, источник неоднозначен или товара недостаточно, заказ не создаётся.

После оплаты WEB-заказа POS включает backend ID заказа в `settledWebOrderIds`. Новый физический snapshot
уже учитывает продажу, поэтому backend одновременно закрывает соответствующий резерв и не вычитает
заказ второй раз. После перезапуска POS восстанавливает эти ID из существующей истории оплаченных чеков.

## Онлайн заказ и онлайн меню

POS передаёт два независимых признака товара только при ручной синхронизации каталога:

- `availableOnline` → `products.available_online`: товар доступен на странице оформления заказа;
- `visibleInOnlineMenu` → `products.visible_in_menu`: товар показывается в отдельном меню для просмотра.

Страница заказа использует `GET /api/menu`, а меню — `GET /api/menu?surface=menu`. Поле `description`
общее для обеих карточек. Перед выкладкой этой версии нужно применить
`supabase/migrations/20261002230000_product_online_channels.sql`. До применения миграции backend
сохраняет прежнее поведение: синхронизация и меню временно используют `available_online`.

## Кэширование гостевого сайта

Статические CSS/JavaScript-файлы браузер кэширует на час и может использовать во время фонового
обновления ещё сутки. HTML всегда перепроверяется. Каталог хранится в `localStorage` отдельно для
страницы меню и онлайн-заказа семь дней. Формат кэша версионирован; ошибки и недоступный
`localStorage` не мешают загрузке сайта.

Каждая ручная синхронизация POS меняет `catalogRevision`. При открытии страницы компактный
`GET /api/menu/availability` без кэша возвращает одновременно актуальные остатки и текущую ревизию.
Если ревизия не изменилась, полный каталог не загружается. Если появился товар, изменилась карточка
или категория, браузер запрашивает версионированный `GET /api/menu?...&revision=...` и хранит его
семь дней. Старые картинки остаются в browser cache, поэтому догружаются только новые URL.

Загрузка нового изображения формирует URL с SHA-256 версией (`?v=...`) и задаёт недельный
`Cache-Control` в Supabase Storage. Замена изображения получает другой URL и сразу обходит старый
кэш после следующей ручной синхронизации каталога. При открытии корзины и непосредственно перед
checkout остатки снова запрашиваются через компактный endpoint с `cache: no-store`. Атомарная
серверная проверка и резервирование остаются окончательной защитой.

## Один активный подарок лояльности

В каждой программе у клиента одновременно может быть только один подарок. После достижения порога
прогресс становится нулевым и не увеличивается, пока подарок не использован. Если подарок используется
в чеке, оплаченные подходящие позиции этого же чека начинают следующий цикл; подарочная позиция в
начислении не участвует. Позиции сверх порога, который выдал подарок, не переносятся.

Миграции `20261002231817_single_active_loyalty_reward.sql` и
`20261002232845_atomic_single_reward_adjustment_and_reversal.sql` приводят существующие программы и
балансы к этому правилу через append-only корректирующие записи ledger и сохраняют инвариант при
ручной корректировке и возврате. Telegram получает одно сообщение на чек с названием программы,
прогрессом и остатком до подарка либо с состоянием доступного подарка.

## Часы работы и сон Railway

- `00:00–06:00` по `Europe/Minsk`: страницы меню и онлайн-заказа возвращают временную страницу
  закрытия; публичные menu API недоступны.
- `06:00–10:00` и `23:00–00:00`: меню можно смотреть, но checkout отключён.
- `10:00–23:00`: онлайн-заказы принимаются.
- `VENUE_TIME_ZONE` позволяет заменить часовой пояс без изменения кода.

В `railway.toml` включён `sleepApplication`. Ночью backend прекращает Telegram polling, закрывает
SSE-поток iPad с длинным интервалом переподключения и не запускает очистку заказов. После 5–10 минут
без исходящего трафика Railway может остановить контейнер. Первый запрос после сна может получить
задержку холодного запуска; POS и защищённые служебные API расписанием сайта не блокируются.

Перед выкладкой server-кода нужно применить
`supabase/migrations/20261002153000_event_driven_availability.sql`. Миграция добавляет
`availability_states`, `product_availability`, `web_order_reservations` и атомарные RPC; RLS включён,
доступ `anon`/`authenticated` закрыт, исполнение разрешено только `service_role`. После миграции и
выкладки backend первый snapshot создаётся следующей складской операцией на POS либо существующей
ручной синхронизацией меню. До первого snapshot сайт безопасно считает остаток неподтверждённым.

## Owner и роли POS — подготовлено к отдельному включению

Модуль `owner-auth.js` добавляет подтверждение единственного владельца и восстановление PIN через существующий Telegram-бот. Обычный вход, права ролей и PIN остаются на iPad в Keychain. Сервер не получает PIN и не изменяет чеки, смены, товары или остатки.

### Подготовка сервера

1. Проверить backup БД. Применить `supabase/migrations/20260923205227_owner_access.sql` через принятый deployment pipeline. Миграция создаёт отдельную singleton-таблицу с RLS и атомарный CAS RPC. Клиентским ролям `anon`/`authenticated` доступ запрещён; работать может только service role. Повторный запуск сохраняет существующего Owner.
2. Установить зависимости через `npm ci`. Запуск остаётся `npm start` → `ready-server.js`; существующие checkout/уведомления готовности не заменяются.
3. Развернуть дополнение `src/owner.js` в **существующем** сервисе `project_bot`. Он уже использует long polling; второй процесс бота/webhook запускать нельзя.
4. Заполнить переменные окружения ниже. До этого Owner API отвечает отказом, без запасного пароля или автоматического назначения первого пользователя.
5. В согласованное окно обслуживания перевыпустить старый токен этого же бота через BotFather: прежний POS хранил его на устройстве. Новый токен вводится только в секреты backend и существующего сервиса бота. Не отправлять токены в чат и не возвращать их на iPad.
6. Установить новый POS, привязать владельца и назначить личные PIN всем работающим сотрудникам до начала смены. Проверить отправку обоих отчётов и обычное оформление заказа через бот. Не выпускать обновление кассирам отдельно от настройки backend/бота.

| Переменная backend | Назначение |
| --- | --- |
| `OWNER_AUTH_ENABLED=true` | Явное включение Owner API и отправки отчётов |
| `OWNER_PRIMARY_DEVICE_ID` | Уже проверенный `devices.id` именно рабочего iPad; не произвольный новый device key |
| `OWNER_BOOTSTRAP_TELEGRAM_ID` | Личный числовой ID будущего владельца, проверенный при вводе в эксплуатацию; новый бот умеет `/myid` в личном чате |
| `OWNER_BOT_USERNAME` | Имя того же бота без `@` |
| `OWNER_BOT_SHARED_SECRET` | Случайный отдельный секрет 32–64 base64url-символа; одинаковый на backend и в сервисе бота |
| `OWNER_VENUE_NAME` | Название заведения в подтверждении |
| `TELEGRAM_BOT_TOKEN` | Новый серверный токен того же бота |
| `POS_REPORT_CHAT_ID` | Фиксированный получатель прежних отчётов о сменах |
| `POS_REPORT_THREAD_ID` | Необязательная тема группы |

У сервиса бота дополнительно: `OWNER_API_URL` = HTTPS-адрес этого backend, `OWNER_BOT_SHARED_SECRET` = тот же отдельный секрет. `TELEGRAM_BOT_TOKEN` остаётся существующей переменной запуска бота. Нельзя переиспользовать ключ POS или Supabase service role как bot shared secret.

### Контракт и защита

- POST `/api/owner/start`, `/status`, `/finish`, `/cancel`: `X-Device-Key`, соответствующий активному `OWNER_PRIMARY_DEVICE_ID`; proof/installation ID запроса обязательны после создания.
- При `OWNER_AUTH_ENABLED=true` прежний `/api/phone-verification/:token/confirm` тоже требует `X-Owner-Bot-Secret`. Обновлённый существующий бот передаёт его. До включения флага поведение старого checkout сохраняется для согласованного перехода.
- POST `/api/owner/bot`: отдельный `X-Owner-Bot-Secret`; Telegram ID поступает из проверенного контекста существующего бота, в личном чате.
- Срок подтверждения 10 минут; максимум 6 новых запросов в час. Новый запрос отменяет предыдущий незавершённый запрос этой установки.
- Хранятся только хеши случайных proof и deep-link token. Назначение Owner/повышение recovery epoch выполняется CAS-транзакцией. Повтор завершения возвращает тот же результат в течение суток, пока epoch не заменён.
- После потери ответа или ошибки Keychain завершение можно повторить. После истечения суток та же установка и тот же сотрудник могут заново подтвердиться уже как восстановление; другой iPad/сотрудник не заменяет Owner.
- POST `/api/owner/report` отправляет текст/изображение только фиксированному серверному получателю. Секрет бота не отдаётся POS. Ограничение 12 сообщений в минуту на процесс, HTTP JSON-лимит 14 MB только для этого маршрута; остальные лимиты не повышены. Это ограничение всплесков, не распределённая квота.
- Текущий контракт: одно заведение и один доверенный iPad на backend. Перенос владения, утеря iPad/Keychain или одновременно PIN и Telegram требуют отдельной проверенной процедуры поддержки; автоматического обхода нет.

### Проверки

`node --test tests/*.mjs tests/*.cjs`: Owner service, маршруты, чужое устройство/Telegram, повтор/просрочка/гонки, фиксированный получатель отчётов, существующие web-validation сценарии. SQL исполняется тестом на PGlite (PostgreSQL WASM), включая RLS/grants и повторное применение миграции. Это не проверка развёрнутого Supabase/PostgREST.

## Уведомление рабочего устройства о новом онлайн-заказе

- Применить миграцию `supabase/migrations/20261004144957_device_telegram_order_alerts.sql`.
- POS вручную вызывает `PUT /api/device/telegram-order-notifications` с `X-Device-Key` после локального сохранения Telegram-настроек. Backend хранит указанный в POS Telegram ID рабочего устройства и флаг; токен бота из POS не передаётся.
- После успешного `finalize_verified_checkout` с `duplicate: false` backend отправляет через серверный `TELEGRAM_BOT_TOKEN` сообщение `Получен онлайн заказ проверьте POS` всем активным устройствам с включённым флагом.
- Отправка не зависит от EventSource, открытого приложения или экрана iPad. Ошибка Telegram журналируется и не откатывает созданный заказ.
