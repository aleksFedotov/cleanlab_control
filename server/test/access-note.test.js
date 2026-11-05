// P2.4: access_note («как добраться») у клиента — сохранение, нормализация,
// отдача водителю в getDriverRoute, идемпотентность мини-миграции схемы.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeCtx, loginOwner, loginDriver, TODAY } = require('./helpers/serverMocks');
const db = require('../db');

test('saveClient: access_note round-trip с многострочным текстом', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const note = 'Арка со двора\nкод калитки 4321\n2-й подъезд';
  const res = ctx.api.saveClient(owner, { name: 'Отель А', access_note: note });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.client.access_note, note);
  const refs = ctx.api.getRefs(owner);
  assert.strictEqual(refs.clients.find(c => c.id === res.client.id).access_note, note);
});

test('saveClient: access_note trim и обрезка до 2000 символов', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const long = '  ' + 'а'.repeat(2500) + '  ';
  const res = ctx.api.saveClient(owner, { name: 'Отель Б', access_note: long });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.client.access_note.length, 2000);
  assert.strictEqual(res.client.access_note, 'а'.repeat(2000));
});

test('saveClient: без access_note → пустая строка; обновление меняет поле', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const res = ctx.api.saveClient(owner, { name: 'Отель В' });
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.client.access_note, '');
  const upd = ctx.api.saveClient(owner, { id: res.client.id, access_note: 'звонить охране' });
  assert.ok(upd.ok, upd.error);
  assert.strictEqual(upd.client.access_note, 'звонить охране');
  // Обновление с NULL/undefined (старые строки) → ''
  const upd2 = ctx.api.saveClient(owner, { id: res.client.id, access_note: null });
  assert.strictEqual(upd2.client.access_note, '');
});

test('getDriverRoute: у визита есть access_note клиента, пусто → ""', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const driver = loginDriver();
  const c1 = ctx.api.saveClient(owner, { name: 'С подсказкой', access_note: 'арка со двора' }).client.id;
  const c2 = ctx.api.saveClient(owner, { name: 'Без подсказки' }).client.id;
  ctx.api.addDeliveryVisit(owner, c1, TODAY);
  ctx.api.addDeliveryVisit(owner, c2, TODAY);

  const r = ctx.api.getDriverRoute(driver, TODAY);
  assert.ok(r.ok, r.error);
  const v1 = r.visits.find(v => v.client_id === c1);
  const v2 = r.visits.find(v => v.client_id === c2);
  assert.strictEqual(v1.access_note, 'арка со двора');
  assert.strictEqual(v2.access_note, '');

  // После правки клиента маршрут отдаёт новое значение
  ctx.api.saveClient(owner, { id: c1, access_note: 'новый код 99' });
  const r2 = ctx.api.getDriverRoute(driver, TODAY);
  assert.strictEqual(r2.visits.find(v => v.client_id === c1).access_note, 'новый код 99');
});

test('схема v8: повторный createTables_ не дублирует колонку access_note', () => {
  const tmp = path.join(os.tmpdir(), `cleanlab-test-${process.pid}-${Date.now()}.sqlite`);
  try {
    const d1 = db.openTest(tmp); // createTables_ на пустой БД
    d1.close();
    const d2 = db.openTest(tmp); // повторно: мини-миграция по PRAGMA, не падает
    const cols = d2.prepare('PRAGMA table_info("Clients")').all().map(r => r.name);
    assert.strictEqual(cols.filter(c => c === 'access_note').length, 1);
    d2.close();
  } finally {
    ['', '-wal', '-shm'].forEach(suf => {
      try { fs.unlinkSync(tmp + suf); } catch { /* файла может не быть */ }
    });
  }
});
