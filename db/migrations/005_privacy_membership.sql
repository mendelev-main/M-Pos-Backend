-- Native PostgreSQL: optional, verified loyalty membership and retention staging.
BEGIN;
CREATE TABLE public.legal_document_archive(version text NOT NULL,slug text NOT NULL,body text NOT NULL,sha256 text NOT NULL,PRIMARY KEY(version,slug));
CREATE TABLE public.loyalty_memberships(customer_id uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE RESTRICT,status text NOT NULL CHECK(status IN ('active','withdrawn','expired')),version bigint NOT NULL DEFAULT 1,consented_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,revoked_at timestamptz,document_version text NOT NULL,last_activity_key text);
CREATE INDEX loyalty_memberships_expiration ON public.loyalty_memberships(expires_at) WHERE status='active';
CREATE TABLE public.privacy_devices(device_id uuid PRIMARY KEY REFERENCES public.devices(id),protocol_version integer NOT NULL,last_seen_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON public.privacy_devices FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.privacy_devices TO mpos_app;
CREATE TABLE public.privacy_access_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),token_hash text NOT NULL UNIQUE,verification_token_hash text NOT NULL,expires_at timestamptz NOT NULL,withdrawn_at timestamptz);
CREATE INDEX privacy_access_expiry ON public.privacy_access_sessions(expires_at);
CREATE TABLE public.privacy_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,checkout_id uuid REFERENCES public.checkout_sessions(id) ON DELETE SET NULL,event_type text NOT NULL CHECK(event_type IN ('order_acknowledged','loyalty_consented','loyalty_withdrawn','loyalty_expired')),document_version text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(checkout_id,event_type));
CREATE TABLE public.privacy_retention_state(id boolean PRIMARY KEY DEFAULT true CHECK(id),apply_order_contacts boolean NOT NULL DEFAULT false,last_run_at timestamptz,last_report jsonb NOT NULL DEFAULT '{}'::jsonb);
INSERT INTO public.privacy_retention_state(id) VALUES(true);
ALTER TABLE public.customers ADD COLUMN privacy_retired_at timestamptz;
ALTER TABLE public.orders ADD COLUMN privacy_closed_at timestamptz;
ALTER TABLE public.orders ADD COLUMN privacy_hold_until timestamptz;
ALTER TABLE public.orders ADD COLUMN privacy_redacted_at timestamptz;
CREATE INDEX privacy_orders_due ON public.orders(privacy_closed_at) WHERE privacy_redacted_at IS NULL;
CREATE TABLE public.privacy_pos_tasks(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,order_external_id text,order_id uuid,customer_id uuid,membership_version bigint,task_type text NOT NULL CHECK(task_type IN ('redact_order','stop_loyalty','redact_customer')),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.privacy_pos_task_receipts(device_id uuid NOT NULL REFERENCES public.devices(id),task_id bigint NOT NULL REFERENCES public.privacy_pos_tasks(id),applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(device_id,task_id));
REVOKE ALL ON public.legal_document_archive,public.loyalty_memberships,public.privacy_access_sessions,public.privacy_events,public.privacy_retention_state,public.privacy_pos_tasks,public.privacy_pos_task_receipts FROM PUBLIC;
GRANT SELECT ON public.legal_document_archive TO mpos_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.loyalty_memberships,public.privacy_access_sessions,public.privacy_events,public.privacy_retention_state,public.privacy_pos_tasks,public.privacy_pos_task_receipts TO mpos_app;
GRANT USAGE,SELECT ON SEQUENCE public.privacy_pos_tasks_id_seq TO mpos_app;
INSERT INTO public.legal_document_archive VALUES('2026-10-18.1','offer','ИП Менделева Любовь Валентиновна, УНП 391085703. Республика Беларусь, Витебская область, г. Дубровно, ул. Почтовая, 6. Телефон: +375 33 376-26-99.
Сайт: https://project-dubrovno.store/.
Заказы принимаются ежедневно с 10:00 до 22:00 по времени Беларуси. Продукция, состав, цены и доступность указаны в каталоге и открытых карточках товаров. Цены — в белорусских рублях.
Самовывоз: г. Дубровно, ул. Почтовая, 6. Оплата в заведении — наличными или банковской картой. Курьер принимает только наличные; терминала у курьера нет. Онлайн-оплата на сайте не производится.
Доставка собственными сотрудниками платная, минимальной суммы заказа нет. Территория — г. Дубровно и прилегающие населённые пункты на расстоянии до 5 км от центра города по дорогам общего пользования. Выбранный тариф и итоговая стоимость показываются до оформления. При вопросах о зоне свяжитесь с заведением до заказа.
Нажимая «Оформить заказ», покупатель принимает изложенные условия и начинает оформление с подтверждением телефона через Telegram. После успешного подтверждения система создаёт заказ. Время готовности сообщается после получения заказа через Telegram; время доставки уточняется при согласовании исполнения. Подтверждение телефона и сообщение о создании не являются сообщением о готовности.
Для изменения, отмены, уточнения срока или предъявления претензии свяжитесь с заведением по указанному телефону; письменные обращения принимаются по адресу ИП. Права потребителя, порядок отказа, возврата оплаты и ответственность определяются законодательством Республики Беларусь. Эти условия не уменьшают обязательных гарантий и не устанавливают общего запрета возврата оплаты за непереданную продукцию.
При чрезвычайных препятствиях, опасных дорожных условиях или официальных ограничениях приём либо исполнение заказов может быть временно ограничено с уведомлением покупателей. Обстоятельства не признаются автоматически непреодолимой силой; по уже полученным заказам согласовываются дальнейшие действия с сохранением законных прав покупателя.
Обработка данных описана в Политике. Участие в лояльности добровольное, не является условием обычного заказа. Редакция условий сохраняется вместе с оформлением.','0c9930d8acf99f949fd0c66ff6f0a73c8530006325b20806cb38581908cb218f');
INSERT INTO public.legal_document_archive VALUES('2026-10-18.1','privacy','Оператор: ИП Менделева Любовь Валентиновна, УНП 391085703. Республика Беларусь, Витебская область, г. Дубровно, ул. Почтовая, 6. Телефон: +375 33 376-26-99.
Для оформления и исполнения заказа используются имя, подтверждённый телефон, состав заказа, его стоимость и статус; для доставки — адрес и необходимые указания. Комментарий добровольный: не указывайте паспортные данные, банковские реквизиты и сведения о здоровье. Основание необходимых действий по заказу — заключаемый/заключённый договор; обязательный учёт ведётся на предусмотренных законодательством основаниях.
Подтверждение телефона производится через Telegram: используются предоставленный контакт, идентификатор пользователя и доступные технические сведения подтверждения, а при наличии — username. Через Telegram сообщаются сведения о статусе и готовности заказа. Это сервисные сообщения, не реклама. Telegram — внешний сервис; размещение основной БД в Беларуси не исключает передачи данных иностранному сервису. Не используйте чужой телефон или чужой контакт для подтверждения.
Данные обрабатываются на сервере и в приложении заведения; доступ сотрудников ограничивается исполнением обязанностей. Курьеры — собственные сотрудники. Данные хранятся на VDS и в резервных копиях в Беларуси по сведениям оператора; поставщик инфраструктуры — support.by (global.support.by). Договорные реквизиты и условия порученной обработки предоставляются по обращению к оператору.
Используются сбор, запись, систематизация, хранение, уточнение, использование, предоставление необходимого доступа, блокирование и удаление. Данные не используются для рекламной рассылки и не продаются рекламным партнёрам.
Для лояльности предусмотрено отдельное добровольное согласие. Обрабатываются имя, подтверждённый телефон, идентификатор участника и необходимые сведения о покупках и накоплениях. Адрес доставки не требуется для лояльности. Условия и срок указаны в отдельном тексте согласия.
Согласованные целевые сроки: временные оформления — 24 часа после истечения; рабочие контакты исполненного/отменённого заказа — 30 дней после окончательного статуса при отсутствии отдельного основания; профиль лояльности — до отзыва и не дольше 24 месяцев без участия. Расчётные документы и материалы обоснованных претензий хранятся отдельно по применимым основаниям и срокам. Истечение ссылки подтверждения само по себе не означает удаления данных.
Очистка контактов заказов и охват локальных/резервных копий вводятся после проверки сохранности документов и процедур восстановления. До завершения этого этапа сроки 24 часа и 30 дней являются планом внедрения, а не заявлением об уже работающем удалении во всех системах. Информацию о фактическом хранении и запрос на прекращение обработки можно получить у оператора.
Вы вправе в предусмотренных законом случаях получить сведения об обработке и получателях, исправить неточные данные, потребовать прекращения или удаления при отсутствии оснований, отозвать согласие и обжаловать нарушения в НЦЗПД. Отзыв не прекращает обработку по самостоятельному законному основанию, например обязательный учёт расчётов. Письменные обращения — по адресу ИП; консультации — по телефону. Для электронного отзыва лояльности доступна страница /privacy/manage после подтверждения телефона. Отказ от лояльности не препятствует обычному заказу.','0f1831395170ff322e0921c60238621f1f0330653734d75ffd49f9177729ea30');
INSERT INTO public.legal_document_archive VALUES('2026-10-18.1','loyalty','Организатор: ИП Менделева Любовь Валентиновна, УНП 391085703. Республика Беларусь, Витебская область, г. Дубровно, ул. Почтовая, 6. Телефон: +375 33 376-26-99.
Участие добровольное и бесплатное. Для подключения выберите отдельную пустую по умолчанию отметку при оформлении и подтвердите свой телефон. Обычный заказ доступен без подключения. Программы могут отличаться перечнем участвующих товаров и количеством покупок до подарка. Действующие условия конкретных программ доступны на странице /legal/programs и в заведении; при отсутствии активной программы начисления не производятся.
Покупки учитываются после оплаты и обработки продажи заведением. Подарок начисляется при достижении указанного количества; одновременно доступен не более одного подарка в каждой программе. Пока подарок не использован, новое накопление в этой программе приостановлено. Выбор и использование подарка согласуются при расчёте в заведении. Подарки нельзя обменять на деньги. Возврат покупки может корректировать связанные начисления в пределах применимых правил и законных прав покупателя.
При добровольном выходе и отзыве согласия участие прекращается, оставшиеся подарки и незавершённые накопления аннулируются. Обычные заказы доступны. Прежние накопления не обнуляются автоматически только вследствие внедрения согласий. Если в течение 24 месяцев нет покупок, учтённых в программе, участие и оставшиеся подарки прекращаются. Этот срок не продлевается служебными повторами или синхронизацией. До получения проверяемого согласия новые начисления и списания по старой карточке заблокированы. Вопросы восстановления доступа и прекращения участия решаются с организатором.
Последующая покупка без действующего согласия не возобновляет участие. Отсутствие галочки в очередном заказе не является отзывом ранее данного действующего согласия. Прекратить участие можно на /privacy/manage после подтверждения телефона либо обратиться к организатору.','91f3c8092bf361535d8d6cbb24c62e1fd9b58ccc86a8c8c76771af752bb15db9');
INSERT INTO public.legal_document_archive VALUES('2026-10-18.1','consent','Оператор, получающий согласие: ИП Менделева Любовь Валентиновна, УНП 391085703. Республика Беларусь, Витебская область, г. Дубровно, ул. Почтовая, 6. Телефон: +375 33 376-26-99.
Цель — подключение и обслуживание участия в программе лояльности, учёт необходимых покупок, начисление и использование подарков. Данные: имя, подтверждённый телефон, идентификатор участника, необходимые сведения о покупках и накоплениях; для связи через Telegram — идентификатор пользователя и доступный username. Адрес доставки и рекламные цели в согласие не включаются.
Действия: сбор, запись, систематизация, хранение, уточнение, использование, предоставление необходимого доступа сотрудникам, передача между сервером и приложением заведения, блокирование и удаление. Обработка автоматизированная и с участием сотрудников. Инфраструктура — support.by (global.support.by), сервер и копии в Беларуси по сведениям оператора; используется внешний сервис Telegram для подтверждения телефона и предусмотренных сервисных сообщений. Дополнительные сведения о фактических получателях и условиях предоставляются оператором по указанному контакту.
Срок: до отзыва, но не дольше 24 месяцев со дня получения согласия или последней покупки, учтённой в программе, в зависимости от более поздней даты. Продление вследствие покупки действует только при активном участии. Служебный обмен, просмотр сайта и повторная доставка одного события срок не продлевают.
Согласие добровольное. Отказ означает отсутствие подключения к программе, но не отказ в обычном заказе. При отзыве участие, оставшиеся подарки и незавершённые накопления прекращаются. Вы можете отозвать согласие на /privacy/manage после подтверждения телефона, а также обратиться к оператору предусмотренным законом способом; отдельный рекламный отказ не требуется, рекламы нет.
Вы вправе получить информацию об обработке и получателях, требовать исправления неточностей, прекращения обработки и удаления при отсутствии оснований, обжаловать нарушения в НЦЗПД. После отзыва обработка для этой цели прекращается, необходимые удаление/блокирование и ответ выполняются в применимые законные сроки; самостоятельные основания, например обязательные документы расчётов, рассматриваются отдельно. Само внедрение новой процедуры согласия не аннулирует прежние подарки; при добровольном выходе или 24 месяцах без участия они прекращаются по правилам программы.
Отметка в форме связывается с подтверждённым телефоном, временем и редакцией условий. Наличие старой карточки само по себе не является согласием. Подробности — в Политике обработки персональных данных.','0cb7c73a501fd2d83e00d1df4b8d1c448a0df8165769511a7c9b208ed558fbe3');

CREATE FUNCTION public.loyalty_membership_active(p_customer uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT EXISTS(SELECT 1 FROM public.loyalty_memberships WHERE customer_id=p_customer AND status='active' AND expires_at>now()) $$;
CREATE FUNCTION public.privacy_finalize_membership() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE cid uuid;m public.loyalty_memberships;doc text;
BEGIN
 IF NEW.status<>'ORDER_CREATED' OR OLD.status='ORDER_CREATED' THEN RETURN NEW; END IF;
 doc=NEW.order_payload->'legal'->>'version';
 IF doc IS DISTINCT FROM '2026-10-18.1' OR (NEW.order_payload->'legal'->>'acknowledged') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'LEGAL_VERSION_REQUIRED'; END IF;
 SELECT customer_id INTO cid FROM public.orders WHERE id=NEW.order_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||cid::text,0));
 INSERT INTO public.privacy_events(customer_id,checkout_id,event_type,document_version) VALUES(cid,NEW.id,'order_acknowledged',doc);
 SELECT * INTO m FROM public.loyalty_memberships WHERE customer_id=cid FOR UPDATE;
 IF NEW.order_payload->>'loyaltyOptIn'='true' AND (m.revoked_at IS NULL OR NEW.created_at>m.revoked_at) THEN
  -- Existing active consent is not renewed merely by checkout, browsing or a duplicate.
  IF NOT coalesce(m.status='active' AND m.expires_at>now(),false) THEN
   IF m.customer_id IS NOT NULL AND m.expires_at<=now() THEN INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 SELECT l.customer_id,l.program_id,'MANUAL_ADJUSTMENT',(-sum(l.progress_delta))::integer,(-sum(l.reward_delta))::integer,
 'privacy-close:'||l.customer_id::text||':'||membership_row.version::text||':'||l.program_id::text||'',
 jsonb_build_object('reason','membership_terminated','membershipVersion',membership_row.version)
 FROM public.loyalty_ledger l JOIN public.loyalty_memberships membership_row ON membership_row.customer_id=l.customer_id
 WHERE l.customer_id=cid GROUP BY l.customer_id,l.program_id,membership_row.version
 HAVING sum(l.progress_delta)<>0 OR sum(l.reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING; END IF;
   INSERT INTO public.loyalty_memberships(customer_id,status,consented_at,expires_at,document_version) VALUES(cid,'active',now(),now()+interval '24 months',doc)
   ON CONFLICT(customer_id) DO UPDATE SET status='active',version=public.loyalty_memberships.version+1,consented_at=now(),expires_at=now()+interval '24 months',document_version=doc,last_activity_key=NULL;
   INSERT INTO public.privacy_events(customer_id,checkout_id,event_type,document_version) VALUES(cid,NEW.id,'loyalty_consented',doc);
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_checkout_finalized AFTER UPDATE OF status ON public.checkout_sessions FOR EACH ROW EXECUTE FUNCTION public.privacy_finalize_membership();
CREATE FUNCTION public.withdraw_loyalty_membership(p_access_hash text) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE s public.privacy_access_sessions;v public.phone_verifications;cid uuid;m public.loyalty_memberships;
BEGIN
 SELECT * INTO s FROM public.privacy_access_sessions WHERE token_hash=p_access_hash AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('status',410,'error','Подтвердите телефон заново');END IF;
 SELECT * INTO v FROM public.phone_verifications WHERE token_hash=s.verification_token_hash AND status IN ('VERIFIED','CONSUMED');
 IF NOT FOUND THEN RETURN jsonb_build_object('status',403,'error','Подтвердите телефон через Telegram');END IF;
 SELECT id INTO cid FROM public.customers WHERE normalized_phone=v.phone;
 IF cid IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||cid::text,0));
  SELECT * INTO m FROM public.loyalty_memberships WHERE customer_id=cid FOR UPDATE;
  IF FOUND AND m.status<>'withdrawn' THEN
   UPDATE public.loyalty_memberships SET status='withdrawn',version=version+1,revoked_at=now() WHERE customer_id=cid;
   INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 SELECT l.customer_id,l.program_id,'MANUAL_ADJUSTMENT',(-sum(l.progress_delta))::integer,(-sum(l.reward_delta))::integer,
 'privacy-close:'||l.customer_id::text||':'||membership_row.version::text||':'||l.program_id::text||'',
 jsonb_build_object('reason','membership_terminated','membershipVersion',membership_row.version)
 FROM public.loyalty_ledger l JOIN public.loyalty_memberships membership_row ON membership_row.customer_id=l.customer_id
 WHERE l.customer_id=cid GROUP BY l.customer_id,l.program_id,membership_row.version
 HAVING sum(l.progress_delta)<>0 OR sum(l.reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING;
   INSERT INTO public.privacy_events(customer_id,event_type,document_version) VALUES(cid,'loyalty_withdrawn',m.document_version);
   INSERT INTO public.privacy_pos_tasks(customer_id,membership_version,task_type) SELECT cid,version,'stop_loyalty' FROM public.loyalty_memberships WHERE customer_id=cid;
  ELSIF NOT FOUND THEN
   -- Tombstone prevents an older unverified checkout from enrolling after this withdrawal.
   INSERT INTO public.loyalty_memberships(customer_id,status,consented_at,expires_at,revoked_at,document_version) VALUES(cid,'withdrawn',now(),now(),now(),'2026-10-18.1');
   INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 SELECT l.customer_id,l.program_id,'MANUAL_ADJUSTMENT',(-sum(l.progress_delta))::integer,(-sum(l.reward_delta))::integer,
 'privacy-close:'||l.customer_id::text||':'||membership_row.version::text||':'||l.program_id::text||'',
 jsonb_build_object('reason','membership_terminated','membershipVersion',membership_row.version)
 FROM public.loyalty_ledger l JOIN public.loyalty_memberships membership_row ON membership_row.customer_id=l.customer_id
 WHERE l.customer_id=cid GROUP BY l.customer_id,l.program_id,membership_row.version
 HAVING sum(l.progress_delta)<>0 OR sum(l.reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING;
   INSERT INTO public.privacy_pos_tasks(customer_id,membership_version,task_type) SELECT cid,version,'stop_loyalty' FROM public.loyalty_memberships WHERE customer_id=cid;
  END IF;
 END IF;
 UPDATE public.privacy_access_sessions SET withdrawn_at=coalesce(withdrawn_at,now()) WHERE id=s.id;
 RETURN jsonb_build_object('ok',true,'active',false);
END $$;
-- Keep the financial algorithm unchanged behind an unexposed owner-only entry point.
ALTER FUNCTION public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer) RENAME TO apply_loyalty_sale_internal;
REVOKE ALL ON FUNCTION public.apply_loyalty_sale_internal(uuid,uuid,text,text,integer,integer,integer,integer) FROM PUBLIC,mpos_app;
CREATE FUNCTION public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer,bigint,timestamptz)
RETURNS TABLE(duplicate boolean,progress bigint,rewards bigint,granted integer,redeemed integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m public.loyalty_memberships;result record;key text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0));
 SELECT * INTO m FROM public.loyalty_memberships WHERE customer_id=$1 FOR UPDATE;
 IF NOT FOUND OR m.status<>'active' OR m.expires_at<=now() OR m.version IS DISTINCT FROM $9 THEN RAISE EXCEPTION 'LOYALTY_CONSENT_REQUIRED';END IF;
 IF $10 IS NULL OR $10<m.consented_at OR $10>now()+interval '5 minutes' THEN RAISE EXCEPTION 'LOYALTY_EVENT_TIME_INVALID';END IF;
 key=$3;
 SELECT * INTO result FROM public.apply_loyalty_sale_internal($1,$2,$3,$4,$5,$6,$7,$8);
 IF NOT result.duplicate AND ($5>0 OR $6>0) THEN UPDATE public.loyalty_memberships SET expires_at=greatest(expires_at,least($10,now())+interval '24 months'),last_activity_key=key WHERE customer_id=$1;END IF;
 RETURN QUERY SELECT result.duplicate,result.progress,result.rewards,result.granted,result.redeemed;
END $$;
-- Legacy callers cannot bypass consent by selecting the old signature.
CREATE FUNCTION public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer)
RETURNS TABLE(duplicate boolean,progress bigint,rewards bigint,granted integer,redeemed integer)
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'LOYALTY_CONSENT_REQUIRED';END $$;
ALTER FUNCTION public.apply_single_reward_reversal(uuid,text) RENAME TO apply_single_reward_reversal_internal;
REVOKE ALL ON FUNCTION public.apply_single_reward_reversal_internal(uuid,text) FROM PUBLIC,mpos_app;
CREATE FUNCTION public.apply_single_reward_reversal(p_customer_id uuid,p_pos_order_id text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||p_customer_id::text,0));
 result=public.apply_single_reward_reversal_internal(p_customer_id,p_pos_order_id);
 IF EXISTS(SELECT 1 FROM public.loyalty_memberships WHERE customer_id=p_customer_id AND (status<>'active' OR expires_at<=now())) THEN
 INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 SELECT l.customer_id,l.program_id,'MANUAL_ADJUSTMENT',(-sum(l.progress_delta))::integer,(-sum(l.reward_delta))::integer,
 'privacy-close:'||l.customer_id::text||':'||membership_row.version::text||':'||l.program_id::text||':refund:'||p_pos_order_id,
 jsonb_build_object('reason','membership_terminated','membershipVersion',membership_row.version)
 FROM public.loyalty_ledger l JOIN public.loyalty_memberships membership_row ON membership_row.customer_id=l.customer_id
 WHERE l.customer_id=p_customer_id GROUP BY l.customer_id,l.program_id,membership_row.version
 HAVING sum(l.progress_delta)<>0 OR sum(l.reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING;
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.apply_single_reward_reversal(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_single_reward_reversal(uuid,text) TO mpos_app;
ALTER FUNCTION public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) RENAME TO apply_single_reward_adjustment_internal;
REVOKE ALL ON FUNCTION public.apply_single_reward_adjustment_internal(uuid,uuid,integer,integer,text,jsonb) FROM PUBLIC,mpos_app;
CREATE FUNCTION public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) RETURNS TABLE(progress bigint,rewards bigint) LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||$1::text,0));
 IF NOT public.loyalty_membership_active($1) THEN RAISE EXCEPTION 'LOYALTY_CONSENT_REQUIRED';END IF;
 RETURN QUERY SELECT * FROM public.apply_single_reward_adjustment_internal($1,$2,$3,$4,$5,$6);
END $$;
REVOKE ALL ON FUNCTION public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_single_reward_adjustment(uuid,uuid,integer,integer,text,jsonb) TO mpos_app;
CREATE FUNCTION public.privacy_terminal_status() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN IF NEW.status IN ('completed','cancelled','canceled','returned') AND OLD.status IS DISTINCT FROM NEW.status THEN NEW.privacy_closed_at=now();ELSIF NEW.status='new' THEN NEW.privacy_closed_at=NULL;END IF;RETURN NEW;END $$;
CREATE TRIGGER privacy_order_closed BEFORE UPDATE OF status ON public.orders FOR EACH ROW EXECUTE FUNCTION public.privacy_terminal_status();
-- Historical timestamps are unknown: no backdating and no immediate removal of old records.
UPDATE public.orders SET privacy_closed_at=now() WHERE status IN ('completed','cancelled','canceled','returned');
CREATE FUNCTION public.privacy_retention_report() RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
SELECT jsonb_build_object(
 'expiredCheckouts',(SELECT count(*) FROM public.checkout_sessions WHERE expires_at<now()-interval '24 hours'),
 'expiredVerifications',(SELECT count(*) FROM public.phone_verifications WHERE expires_at<now()-interval '24 hours'),
 'profileContactsDue',(SELECT count(*) FROM public.loyalty_memberships m JOIN public.customers c ON c.id=m.customer_id WHERE m.status IN ('withdrawn','expired') AND m.revoked_at<now()-interval '14 days' AND c.privacy_retired_at IS NULL),
 'tabletsReady',(SELECT count(*) FROM public.privacy_devices WHERE protocol_version>=1),
 'expiredMemberships',(SELECT count(*) FROM public.loyalty_memberships WHERE status='active' AND expires_at<=now()),
 'orderContactsDue',(SELECT count(*) FROM public.orders WHERE privacy_redacted_at IS NULL AND privacy_closed_at<now()-interval '30 days' AND (privacy_hold_until IS NULL OR privacy_hold_until<now())),
 'orderContactDeletionEnabled',(SELECT apply_order_contacts FROM public.privacy_retention_state WHERE id=true),
 'unacknowledgedDeviceTasks',(SELECT count(*) FROM public.privacy_pos_tasks t CROSS JOIN public.devices d WHERE d.is_active AND NOT EXISTS(SELECT 1 FROM public.privacy_pos_task_receipts r WHERE r.task_id=t.id AND r.device_id=d.id))
) $$;
CREATE FUNCTION public.run_privacy_retention(p_apply boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE c record;o record;report jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('privacy-retention',0));
 report=public.privacy_retention_report();
 IF p_apply THEN
  -- Bounded batches; timestamps are expiry rather than last UI poll.
  DELETE FROM public.privacy_access_sessions WHERE id IN(SELECT id FROM public.privacy_access_sessions WHERE expires_at<now()-interval '24 hours' ORDER BY expires_at LIMIT 500);
  DELETE FROM public.checkout_sessions WHERE id IN(SELECT id FROM public.checkout_sessions WHERE expires_at<now()-interval '24 hours' ORDER BY expires_at LIMIT 500);
  DELETE FROM public.phone_verifications WHERE id IN(SELECT v.id FROM public.phone_verifications v WHERE v.expires_at<now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM public.checkout_sessions s WHERE s.verification_token_hash=v.token_hash) AND NOT EXISTS(SELECT 1 FROM public.privacy_access_sessions a WHERE a.verification_token_hash=v.token_hash) ORDER BY v.expires_at LIMIT 500);
  FOR c IN SELECT customer_id FROM public.loyalty_memberships WHERE status='active' AND expires_at<=now() ORDER BY expires_at LIMIT 500 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||c.customer_id::text,0));
   UPDATE public.loyalty_memberships SET status='expired',version=version+1,revoked_at=now() WHERE customer_id=c.customer_id AND status='active' AND expires_at<=now();
   IF FOUND THEN INSERT INTO public.loyalty_ledger(customer_id,program_id,operation_type,progress_delta,reward_delta,idempotency_key,metadata)
 SELECT l.customer_id,l.program_id,'MANUAL_ADJUSTMENT',(-sum(l.progress_delta))::integer,(-sum(l.reward_delta))::integer,
 'privacy-close:'||l.customer_id::text||':'||membership_row.version::text||':'||l.program_id::text||'',
 jsonb_build_object('reason','membership_terminated','membershipVersion',membership_row.version)
 FROM public.loyalty_ledger l JOIN public.loyalty_memberships membership_row ON membership_row.customer_id=l.customer_id
 WHERE l.customer_id=c.customer_id GROUP BY l.customer_id,l.program_id,membership_row.version
 HAVING sum(l.progress_delta)<>0 OR sum(l.reward_delta)<>0 ON CONFLICT(idempotency_key) DO NOTHING;
   INSERT INTO public.privacy_events(customer_id,event_type,document_version) SELECT customer_id,'loyalty_expired',document_version FROM public.loyalty_memberships WHERE customer_id=c.customer_id;INSERT INTO public.privacy_pos_tasks(customer_id,membership_version,task_type) SELECT c.customer_id,version,'stop_loyalty' FROM public.loyalty_memberships WHERE customer_id=c.customer_id;END IF;
  END LOOP;
  FOR c IN SELECT m.customer_id FROM public.loyalty_memberships m JOIN public.customers x ON x.id=m.customer_id WHERE m.status IN ('withdrawn','expired') AND m.revoked_at<now()-interval '14 days' AND x.privacy_retired_at IS NULL ORDER BY m.revoked_at LIMIT 500 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('privacy:'||c.customer_id::text,0));
   IF EXISTS(SELECT 1 FROM public.loyalty_memberships WHERE customer_id=c.customer_id AND status IN ('withdrawn','expired') AND revoked_at<now()-interval '14 days') THEN
    UPDATE public.customers SET name='Удалённый участник',normalized_phone='retired:'||id::text,telegram_user_id=NULL,telegram_username=NULL,last_purchase_at=NULL,privacy_retired_at=now(),updated_at=now() WHERE id=c.customer_id;
    INSERT INTO public.privacy_pos_tasks(customer_id,task_type) VALUES(c.customer_id,'redact_customer');
   END IF;
  END LOOP;
  IF (SELECT apply_order_contacts FROM public.privacy_retention_state WHERE id=true) THEN
   FOR o IN SELECT id,external_id FROM public.orders WHERE privacy_redacted_at IS NULL AND privacy_closed_at<now()-interval '30 days' AND (privacy_hold_until IS NULL OR privacy_hold_until<now()) ORDER BY privacy_closed_at LIMIT 200 FOR UPDATE SKIP LOCKED LOOP
    UPDATE public.orders SET customer_name=NULL,phone=NULL,address=NULL,comment=NULL,customer_id=NULL,tracking_token=NULL,privacy_redacted_at=now() WHERE id=o.id;
    UPDATE public.order_items SET comment=NULL WHERE order_id=o.id;
    INSERT INTO public.privacy_pos_tasks(order_external_id,order_id,task_type) VALUES(o.external_id,o.id,'redact_order');
   END LOOP;
  END IF;
  -- Order-only profiles are not loyalty enrollment. Once every operational order
  -- has been redacted, remove their otherwise orphaned contact record as well.
  FOR c IN SELECT x.id AS customer_id FROM public.customers x WHERE x.privacy_retired_at IS NULL AND x.updated_at<now()-interval '30 days'
   AND NOT EXISTS(SELECT 1 FROM public.loyalty_memberships m WHERE m.customer_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM public.loyalty_ledger l WHERE l.customer_id=x.id)
   AND NOT EXISTS(SELECT 1 FROM public.orders order_row WHERE order_row.customer_id=x.id)
   ORDER BY x.updated_at LIMIT 500 FOR UPDATE SKIP LOCKED LOOP
   UPDATE public.customers SET name='Удалённый клиент',normalized_phone='retired:'||id::text,telegram_user_id=NULL,telegram_username=NULL,last_purchase_at=NULL,privacy_retired_at=now(),updated_at=now() WHERE id=c.customer_id;
   INSERT INTO public.privacy_pos_tasks(customer_id,task_type) VALUES(c.customer_id,'redact_customer');
  END LOOP;
 END IF;
 UPDATE public.privacy_retention_state SET last_run_at=now(),last_report=report||jsonb_build_object('applied',p_apply) WHERE id=true;
 RETURN report||jsonb_build_object('applied',p_apply);
END $$;
REVOKE ALL ON FUNCTION public.loyalty_membership_active(uuid),public.privacy_finalize_membership(),public.withdraw_loyalty_membership(text),public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer,bigint,timestamptz),public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer),public.privacy_terminal_status(),public.privacy_retention_report(),public.run_privacy_retention(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.loyalty_membership_active(uuid),public.privacy_finalize_membership(),public.withdraw_loyalty_membership(text),public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer,bigint,timestamptz),public.apply_loyalty_sale(uuid,uuid,text,text,integer,integer,integer,integer),public.privacy_terminal_status(),public.privacy_retention_report(),public.run_privacy_retention(boolean) TO mpos_app;
COMMIT;
