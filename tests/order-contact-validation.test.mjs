import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/order-validation.js';
import { createCheckoutService } from '../checkout-service.js';
const { normalizePhone, hasProfanity, validateFirstName, validate } = globalThis.OrderValidation;
const clean = { customerName: 'Иван', phone: '+375291234567', address: 'ул. Советская, 10, кв. 2', comment: 'Без лука, пожалуйста', items: [{ productId: 'product', quantity: 1 }] };
const blocked = ['Педик', 'пидор', 'друг пидора', 'гей', 'гейчик', 'геюша', 'сучка', 'сучара', 'педераст', 'педиков', 'пидору', 'гея', 'гею', 'геев', 'сучкой', 'еблан', 'долбоёб', 'блять', 'мудак', 'fuck'];

test('first name accepts letters and compound given names but rejects surnames and non-name syntax', () => {
  for (const name of ['Иван', 'Анна', 'Ли', 'Ілля', 'Łukasz', 'José', 'Jose\u0301', 'Анна-Мария', "Д’Анджело", "D'Angelo", '  Иван  ']) assert.equal(validateFirstName(name), '', name);
  for (const name of ['', 'Иван Иванов', 'Анна\nПетрова', 'Иван123', '@Иван', '<script>', 'Иван_Иванов', '-Анна', 'Анна-', 'Анна--Мария', 'А'.repeat(51)]) assert.ok(validateFirstName(name), name);
});

test('requested slang and inflected insults are rejected without matching ordinary word fragments', () => {
  for (const word of blocked) assert.equal(hasProfanity(word), true, word);
  for (const word of ['педикюр', 'гейзер', 'Страхуем доставку', 'ребенок ждет', 'Хлеб и соль', 'Гейдар', 'бульон', 'ул. Сухая, 7']) assert.equal(hasProfanity(word), false, word);
  assert.equal(validate(clean), '');
  for (const word of blocked) {
    for (const field of ['customerName', 'address', 'comment']) assert.ok(validate({ ...clean, [field]: word }), field + ': ' + word);
    assert.ok(validate({ ...clean, items: [{ ...clean.items[0], comment: word }] }), 'item comment: ' + word);
  }
});

test('backend rejects names, addresses and comments before querying PostgreSQL or creating verification', async () => {
  const service = createCheckoutService({
    query: async () => { throw Error('Unexpected database access'); }, normalizePhone, validateOrderContact: validate,
    phoneVerification: { create: async () => { throw Error('Unexpected verification creation'); } }
  });
  for (const input of [
    { customerName: 'Иван Иванов' }, { customerName: 'Пидор' }, { customerName: 'Иван123' },
    { orderType: 'Доставка', address: 'друг пидора' }, { comment: 'сучара' },
    { items: [{ productId: 'product', quantity: 1, comment: 'геюша' }] }
  ]) {
    const result = await service.create({ ...clean, ...input });
    assert.equal(result.status, 400);
    assert.ok(result.error);
  }
});

test('field validation reports all invalid fields for quiet inline feedback',()=>{
 const errors=globalThis.OrderValidation.validateFields({...clean,orderType:'Доставка',customerName:'Иван Иванов',phone:'+375291',address:'',comment:'сучара'});
 assert.deepEqual(Object.keys(errors),['phone','customerName','address','comment']);
 assert.deepEqual(globalThis.OrderValidation.validateFields(clean),{});
});
