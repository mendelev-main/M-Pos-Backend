# Telegram username при заказе и контакт с планшета

Реализация: бот передаёт ctx.from.username после проверки, что contact.user_id совпадает с senderId. В backend username нормализуется, допускаются только буквы/цифры/underscore, ведущий @ удаляется. Значение берётся только из запроса доверенного бота, проверенного OWNER_BOT_SHARED_SECRET; публичный payload заказа не используется. На сайте новых полей не требуется.

Supabase prilavok: применена миграция verified_customer_telegram_username, зарегистрированная сервером как 20261009193717. SQL сохранён в backend/supabase/verified_customer_telegram_username.sql. Поле customers.telegram_username уже существовало; добавлены phone_verifications.telegram_username и telegram_username_observed. BEFORE trigger синхронизирует username при атомарном создании/обновлении клиента в finalize_verified_checkout, не меняя существующую функцию заказа и резерва. При явно отсутствующем username очищается старое значение. Старый бот, не передающий поле, сохраняет прежнее значение только при прежнем Telegram ID; смена аккаунта очищает устаревшую ссылку.

Проверены новые колонки, активный trigger и security invoker в живой БД. RLS customers/phone_verifications включён; новых публичных грантов и SECURITY DEFINER нет. Advisors: только информационные RLS enabled/no policy для существующих server-only таблиц; новых security ошибок нет. Реальные клиенты/заказы не читались для проверки, тестовые уведомления не отправлялись.

Backend возвращает telegram_username в device-auth customer search/create/loyalty endpoints. Android Web: в «Данные клиента» добавлена кнопка «Написать в Telegram» с валидированной ссылкой t.me. Native host сначала открывает tg://resolve?domain=..., при отсутствии обработчика пробует HTTPS. Кнопка не отправляет сообщения. Если username отсутствует/некорректен, кнопка disabled с пояснением. Старые клиенты не заполняются выдуманными значениями: потребуется новое подтверждение телефона. Username может измениться после последнего подтверждения; хранится последнее наблюдённое значение. Telegram privacy может ограничивать переписку.

Порядок запуска: БД уже подготовлена → развернуть обновлённый backend → обновить бота → установить новую Android сборку. OWNER_BOT_SHARED_SECRET должен совпадать в backend и боте (он уже используется для защищённого подтверждения и owner API). Без доверенной подписи подтверждение старого legacy flow не заполняет username. Токены/ключи не публиковались. Push в main сам по себе не подтверждает обновление запущенных серверных процессов.

Добавлено 7 регрессионных сценариев: нормализация, подтверждение/отсутствие поля старого бота, PGlite trigger (создание/изменение/удаление username и смена ID), bot payload, две проверки Android карточки, Android protocol fallback. Локально только синтаксис JS и git diff --check; тесты/сборка остаются CI. Сквозной заказ и открытие Telegram на планшете pending.

Прогресс: 4/4 этапа реализации (БД, бот/backend, карточка/Android host, регрессии/документация). Развёртывание сервисов и физическая приёмка оцениваются отдельно; проценты аудита R01–R22 эта функция не изменяет.

Приёмка: клиент с username подтверждает заказ → customers.telegram_username заполнен → карточка показывает @username и открывает нужный чат. Повторить для смены username и профиля без username, старого клиента, отсутствующего Telegram приложения. Никаких автоматических сообщений клиенту.

Документация: https://core.telegram.org/bots/api#user ; https://core.telegram.org/api/links#public-username-links ; https://supabase.com/docs/reference/javascript/update . Проверены Supabase changelog и Postgres minor release notice; новая схема не использует затронутые ltree/PGP/btree_gist/custom operators механизмы.
