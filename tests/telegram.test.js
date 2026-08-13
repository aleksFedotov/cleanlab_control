// Тесты T7: webhook (секрет, идемпотентность, /start), дайджест после shift_close,
// fallback-триггер, защита от двойной отправки, флаг только после HTTP 200.
const test = require('node:test');
const assert = require('node:assert');
const { makeApiCtx, loginOwner, loginWorker } = require('./helpers/gasMocks');

const TODAY = '2026-08-12';
const TOMORROW = '2026-08-13';

function hookEvent(body, secret = 'hook-secret') {
  return {
    parameter: { secret },
    postData: { contents: JSON.stringify(body) }
  };
}
const startUpdate = (id, text) => ({ update_id: id, message: { text, chat: { id: 555 } } });

function dayWithDoneWash(ctx) {
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const clientId = ctx.saveClient(owner, { name: 'Отель А' }).client.id;
  const washId = ctx.addToDelivery(owner, clientId, TODAY, TOMORROW).wash.id;
  ctx.startWash(worker, washId, 10);
  ctx.completeWash(worker, washId, [{ item_type_id: 'itm_1', qty: 20 }]);
  return { owner, worker, washId };
}

test('webhook: секрет, /start → запрос PIN, привязка по PIN, идемпотентность', () => {
  const { ctx, propsStore, fetches } = makeApiCtx({ OWNER_CHAT_ID: null });
  ctx.doPost(hookEvent(startUpdate(1, '/start'), 'wrong-secret'));
  assert.strictEqual(fetches.length, 0);

  // /start → бот просит PIN
  ctx.doPost(hookEvent(startUpdate(1, '/start')));
  assert.strictEqual(fetches.length, 1);
  assert.match(fetches[0].payload.text, /введите PIN/);
  assert.strictEqual(propsStore.OWNER_CHAT_ID, null);

  // Ретрай Telegram с тем же update_id — не обрабатывается повторно
  ctx.doPost(hookEvent(startUpdate(1, '/start')));
  assert.strictEqual(fetches.length, 1);

  // Чужой PIN игнорируется
  ctx.doPost(hookEvent(startUpdate(2, '0000')));
  assert.strictEqual(fetches.length, 1);
  assert.strictEqual(propsStore.OWNER_CHAT_ID, null);

  // Верный PIN обычным сообщением → фиксация OWNER_CHAT_ID
  ctx.doPost(hookEvent(startUpdate(3, '1111')));
  assert.strictEqual(propsStore.OWNER_CHAT_ID, '555');
  assert.strictEqual(fetches.length, 2);
  assert.strictEqual(fetches[1].payload.chat_id, 555);
  assert.match(fetches[1].payload.text, /подключены/);

  // Старый формат «/start <pin>» тоже работает
  const ctx2 = makeApiCtx({ OWNER_CHAT_ID: null });
  ctx2.ctx.doPost(hookEvent(startUpdate(1, '/start 1111')));
  assert.strictEqual(ctx2.propsStore.OWNER_CHAT_ID, '555');
});

test('дайджест после shift_close: формат, digest_sent, без дубля', () => {
  const { ctx, fetches } = makeApiCtx();
  const { worker } = dayWithDoneWash(ctx);
  const closed = ctx.closeShift(worker);
  assert.ok(closed.ok);

  assert.strictEqual(fetches.length, 1);
  const msg = fetches[0].payload;
  assert.strictEqual(String(msg.chat_id), '998877');
  assert.match(msg.text, /📊 Прачка360 — итоги 2026-08-12/);
  assert.match(msg.text, /10 кг \(1 стирок\)/);
  assert.match(msg.text, /• Отель А — 10 кг, 20 шт/);
  assert.match(msg.text, /Смена закрыта в 21:30 ✓/);
  // Флаг записан
  assert.strictEqual(ctx.readAll_('Shifts')[0].digest_sent, 'да');
  // Повторная отправка невозможна: смена закрыта, fallback молчит
  ctx.fallbackDigestTrigger();
  assert.strictEqual(fetches.length, 1);
});

test('fallback при незакрытой смене: ⚠ + незавершённые; закрытие после — короткое сообщение', () => {
  const { ctx, fetches } = makeApiCtx();
  const owner = loginOwner(ctx);
  const worker = loginWorker(ctx);
  const clientId = ctx.saveClient(owner, { name: 'Отель А' }).client.id;
  ctx.addToDelivery(owner, clientId, TODAY, TOMORROW); // planned, не завершена

  ctx.fallbackDigestTrigger();
  assert.strictEqual(fetches.length, 1);
  assert.match(fetches[0].payload.text, /⚠ Смена ещё не закрыта/);
  assert.match(fetches[0].payload.text, /Незавершённые: Отель А/);
  assert.match(fetches[0].payload.text, /стирок не было/);
  assert.strictEqual(ctx.readAll_('Shifts')[0].digest_sent, 'да');

  // Владелец всё же закрывает смену (после переноса) — полный дайджест НЕ шлётся
  const washId = ctx.readAll_('Washes')[0].id;
  ctx.deferWash(worker, washId, TOMORROW, 'не успели');
  const closed = ctx.closeShift(worker);
  assert.ok(closed.ok);
  assert.strictEqual(fetches.length, 2);
  assert.strictEqual(fetches[1].payload.text, 'Смена закрыта в 21:30 ✓');
});

test('флаг digest_sent пишется только после HTTP 200', () => {
  const { ctx, fetches, setFetchStatus } = makeApiCtx();
  const { worker } = dayWithDoneWash(ctx);
  setFetchStatus(500);
  const closed = ctx.closeShift(worker);
  assert.ok(closed.ok); // закрытие не ломается из-за Telegram
  assert.strictEqual(fetches.length, 1);
  assert.notStrictEqual(ctx.readAll_('Shifts')[0].digest_sent, 'да');

  // Fallback при закрытой смене не шлёт (spec: fallback только если не закрыта)
  setFetchStatus(200);
  ctx.fallbackDigestTrigger();
  assert.strictEqual(fetches.length, 1);
});

test('без BOT_TOKEN/OWNER_CHAT_ID отправка тихо пропускается', () => {
  const { ctx, fetches } = makeApiCtx({ BOT_TOKEN: null, OWNER_CHAT_ID: null });
  const { worker } = dayWithDoneWash(ctx);
  assert.ok(ctx.closeShift(worker).ok);
  assert.strictEqual(fetches.length, 0);
  assert.notStrictEqual(ctx.readAll_('Shifts')[0].digest_sent, 'да');
});
