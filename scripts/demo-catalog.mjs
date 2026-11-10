export const demoCategories = ['Пицца', 'Горячее', 'Салаты', 'Закуски', 'Десерты', 'Горячие напитки'];
export const demoProducts = [
  ['Маргарита', 'Томаты, моцарелла, базилик. 30 см', 18, 0, 'pizza', 30],
  ['Пепперони', 'Пепперони, моцарелла и томатный соус. 30 см', 23, 0, 'pizza', 25],
  ['Четыре сыра', 'Моцарелла, дорблю, чеддер и пармезан. 30 см', 25, 0, 'pizza', 18],
  ['Пицца с грушей', 'Груша, горгонзола, моцарелла и мёд. 30 см', 26, 0, 'pizza', 0],
  ['Классический бургер', 'Говядина, чеддер, овощи и фирменный соус. 320 г', 19, 1, 'burger', 20],
  ['Чизбургер', 'Двойной чеддер, говядина и маринованный огурец. 340 г', 21, 1, 'burger', 12],
  ['Бургер с курицей', 'Хрустящее филе, салат и соус с травами. 300 г', 17, 1, 'burger', 16],
  ['Грибной бургер', 'Говядина, шампиньоны и сливочный соус. 330 г', 22, 1, 'burger', 8],
  ['Цезарь с курицей', 'Романо, куриное филе, пармезан и сухарики. 250 г', 16, 2, 'salad', 20],
  ['Греческий салат', 'Свежие овощи, фета, маслины и оливковое масло. 260 г', 14, 2, 'salad', 15],
  ['Салат с авокадо', 'Авокадо, томаты, микс зелени и лимонная заправка. 230 г', 18, 2, 'salad', 9],
  ['Зелёный салат', 'Сезонная зелень, огурец и соус с травами. 200 г', 12, 2, 'salad', 7],
  ['Картофель фри', 'Золотистый картофель, соль и соус на выбор. 150 г', 7, 3, 'fries', 40],
  ['Картофельные дольки', 'Запечённые дольки с паприкой и травами. 180 г', 8, 3, 'fries', 25],
  ['Сырные палочки', 'Хрустящая панировка и тягучий сыр. 160 г', 11, 3, 'fries', 14],
  ['Луковые кольца', 'Луковые кольца в лёгком кляре. 150 г', 8, 3, 'fries', 0],
  ['Чизкейк', 'Нежный сливочный чизкейк с ягодным соусом. 140 г', 10, 4, 'cake', 12],
  ['Шоколадный торт', 'Шоколадный бисквит и крем из тёмного шоколада. 150 г', 11, 4, 'cake', 8],
  ['Морковный торт', 'Пряный бисквит, грецкий орех и сливочный крем. 150 г', 10, 4, 'cake', 6],
  ['Ягодный тарт', 'Песочная основа, ванильный крем и ягоды. 130 г', 12, 4, 'cake', 3],
  ['Капучино', 'Эспрессо и нежная молочная пена. 250 мл', 6, 5, 'coffee', null],
  ['Латте', 'Эспрессо и много тёплого молока. 350 мл', 7, 5, 'coffee', null],
  ['Американо', 'Классический чёрный кофе. 200 мл', 4.5, 5, 'coffee', null],
  ['Флэт уайт', 'Двойной эспрессо и бархатное молоко. 200 мл', 7, 5, 'coffee', null],
];

export async function seedDemoCatalog(client) {
  await client.query('BEGIN');
  try {
    // An additional active device would make stock ambiguous; do not change existing POS devices.
    const { rows: otherDevices } = await client.query("SELECT id FROM public.devices WHERE is_active=TRUE AND device_key<>'local-demo-device'");
    if (otherDevices.length) throw new Error('Demo seed requires a local database without another active POS device. Existing devices were preserved.');
    const categories = [];
    for (const [index, name] of demoCategories.entries()) {
      const { rows } = await client.query(`INSERT INTO public.categories(external_id,name,sort_order,available_online,visible_in_menu)
        VALUES($1,$2,$3,TRUE,TRUE) ON CONFLICT(external_id) DO UPDATE SET name=excluded.name,is_active=TRUE,
        available_online=TRUE,visible_in_menu=TRUE,sort_order=excluded.sort_order RETURNING id`, [`demo-category-${index}`, name, index]);
      categories.push(rows[0].id);
    }
    for (const [index, [name, description, price, category, image]] of demoProducts.entries()) {
      await client.query(`INSERT INTO public.products(external_id,name,description,price,category_id,image_url,sort_order,is_active,available_online,visible_in_menu)
        VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,TRUE,TRUE) ON CONFLICT(external_id) DO UPDATE SET name=excluded.name,description=excluded.description,
        price=excluded.price,category_id=excluded.category_id,image_url=excluded.image_url,available_online=TRUE,visible_in_menu=TRUE,is_active=TRUE`,
      [`demo-product-${index}`, name, description, price, categories[category], `/assets/demo/${image}.svg`, index]);
    }
    const { rows } = await client.query(`INSERT INTO public.devices(device_key,name,is_active) VALUES('local-demo-device','Тестовый POS',TRUE)
      ON CONFLICT(device_key) DO UPDATE SET is_active=TRUE RETURNING id`);
    const id = rows[0].id;
    const { rows: revisions } = await client.query('SELECT revision FROM public.availability_states WHERE device_id=$1', [id]);
    const revision = Number(revisions[0]?.revision || 0) + 1;
    await client.query('SELECT public.store_availability_snapshot($1,$2,now(),$3::jsonb,ARRAY[]::text[])',
      [id, revision, JSON.stringify(demoProducts.map((p, index) => ({ externalId: `demo-product-${index}`, quantity: p[5] })))]);
    await client.query('COMMIT');
    return { categories: demoCategories.length, products: demoProducts.length };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
