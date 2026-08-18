// Тесты слоя данных server/db.js (SQLite) — грани поведения src/Db.gs.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');

function fresh() {
  const d = db.openTest(':memory:');
  db._setDbForTests(d);
  return d;
}

test('appendRow_ приводит значения к строкам, пустые поля → ""', () => {
  fresh();
  db.appendRow_('Washes', { id: 'wash_1', client_id: 'cli_1', wash_date: '2026-08-12', status: 'planned', dirty_weight_kg: 12.5, items_total: 7 });
  const rows = db.readAll_('Washes');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].dirty_weight_kg, '12.5'); // всё TEXT
  assert.strictEqual(rows[0].items_total, '7');
  assert.strictEqual(rows[0].comment, ''); // непереданные колонки → ''
});

test('readTail_ возвращает хвост в порядке «старые → новые»', () => {
  fresh();
  for (let i = 1; i <= 10; i++) db.appendRow_('Log', { ts: 't' + i, actor: 'a', action: 'act', entity: String(i), details: '' });
  const tail = db.readTail_('Log', 3);
  assert.deepStrictEqual(tail.map(r => r.entity), ['8', '9', '10']);
});

test('nextId_ = max по хвосту + 1', () => {
  fresh();
  assert.strictEqual(db.nextId_('Washes', 'wash'), 'wash_1');
  db.appendRow_('Washes', { id: 'wash_1', client_id: 'c' });
  db.appendRow_('Washes', { id: 'wash_2', client_id: 'c' });
  assert.strictEqual(db.nextId_('Washes', 'wash'), 'wash_3');
});

test('findRowsBy_ / findById_ возвращают rowNumber=rowid; updateRow_/deleteRow_ по нему', () => {
  fresh();
  db.appendRow_('Clients', { id: 'cli_1', name: 'А', active: 'да' });
  db.appendRow_('Clients', { id: 'cli_2', name: 'Б', active: 'да' });
  const found = db.findRowsBy_('Clients', c => c.active === 'да', 100);
  assert.strictEqual(found.length, 2);
  assert.ok(found.every(r => typeof r.rowNumber === 'number'));

  const byId = db.findById_('Clients', 'cli_2');
  byId.obj.name = 'Б2';
  db.updateRow_('Clients', byId.rowNumber, byId.obj);
  assert.strictEqual(db.findById_('Clients', 'cli_2').obj.name, 'Б2');

  db.deleteRow_('Clients', found[0].rowNumber);
  assert.strictEqual(db.findById_('Clients', 'cli_1'), null);
  assert.ok(db.findById_('Clients', 'cli_2'));
});

test('parseJsonList_: пустое/битое → null, непустой массив → массив', () => {
  assert.strictEqual(db.parseJsonList_(''), null);
  assert.strictEqual(db.parseJsonList_('не json'), null);
  assert.strictEqual(db.parseJsonList_('[]'), null);
  assert.deepStrictEqual(db.parseJsonList_('["itm_1","itm_2"]'), ['itm_1', 'itm_2']);
});

test('кэш справочников: getClients_ кэширует, invalidateRefCache_ сбрасывает', () => {
  fresh();
  db.appendRow_('Clients', { id: 'cli_1', name: 'А', active: 'да' });
  assert.strictEqual(db.getClients_().length, 1);
  // Запись мимо кэша не видна до инвалидации
  db.appendRow_('Clients', { id: 'cli_2', name: 'Б', active: 'да' });
  assert.strictEqual(db.getClients_().length, 1);
  db.invalidateRefCache_();
  assert.strictEqual(db.getClients_().length, 2);
});

test('_setDbForTests изолирует БД между контекстами', () => {
  const d1 = db.openTest(':memory:');
  db._setDbForTests(d1);
  db.appendRow_('Clients', { id: 'cli_1', name: 'А', active: 'да' });
  const d2 = db.openTest(':memory:');
  db._setDbForTests(d2);
  assert.strictEqual(db.readAll_('Clients').length, 0);
});
