// Тесты server/telegram.js: webhook (секрет, идемпотентность, PIN-логин) и дайджест.
// Грани поведения — из tests/telegram.test.js (GAS).
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeCtx, loginOwner, TODAY } = require('./helpers/serverMocks');

// Поднимает express-приложение с webhook на случайном порту, возвращает baseUrl.
async function startWebhook() {
  const ctx = makeCtx();
  const app = express();
  app.use(express.json());
  ctx.telegram.mountTelegram(app);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    ctx, server,
    url: `http://127.0.0.1:${port}/telegram/webhook`,
    // HTTP к серверу — настоящим fetch (globalThis.fetch подменён стабом Bot API)
    post: (url, body) => ctx.httpFetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
  };
}

test('webhook: неверный/отсутствующий секрет — молчаливый 200, update не обрабатывается', async () => {
  const { ctx, server, url, post } = await startWebhook();
  try {
    const update = { update_id: 1, message: { text: '1111', chat: { id: 555 } } };
    let res = await post(url + '?secret=bad', update);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'ok');
    res = await post(url, update); // без секрета
    assert.strictEqual(res.status, 200);
    // OWNER_CHAT_ID не записан, сообщений не отправлено
    assert.strictEqual(ctx.db.readAll_('Settings').find(r => r.key === 'OWNER_CHAT_ID'), undefined);
    assert.strictEqual(ctx.fetches.length, 0);
  } finally { server.close(); }
});

test('webhook: PIN владельца фиксирует OWNER_CHAT_ID в Settings; /start просит PIN', async () => {
  const { ctx, server, url, post } = await startWebhook();
  try {
    // /start без PIN
    let res = await post(url + '?secret=hook-secret', { update_id: 1, message: { text: '/start', chat: { id: 555 } } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(ctx.fetches.length, 1);
    assert.strictEqual(ctx.fetches[0].payload.text, 'Прачка360: введите PIN владельца');
    assert.strictEqual(ctx.fetches[0].payload.chat_id, 555);

    // PIN отдельным сообщением
    res = await post(url + '?secret=hook-secret', { update_id: 2, message: { text: '1111', chat: { id: 555 } } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(ctx.fetches.length, 2);
    assert.ok(ctx.fetches[1].payload.text.includes('дайджесты подключены'));
    const row = ctx.db.readAll_('Settings').find(r => r.key === 'OWNER_CHAT_ID');
    assert.strictEqual(row.value, '555');

    // Старый формат «/start <PIN>» тоже работает
    await post(url + '?secret=hook-secret', { update_id: 3, message: { text: '/start 1111', chat: { id: 777 } } });
    const row2 = ctx.db.readAll_('Settings').find(r => r.key === 'OWNER_CHAT_ID');
    assert.strictEqual(row2.value, '777');
  } finally { server.close(); }
});

test('webhook: идемпотентность по update_id (ретраи Telegram не обрабатываются повторно)', async () => {
  const { ctx, server, url, post } = await startWebhook();
  try {
    const update = { update_id: 42, message: { text: '/start', chat: { id: 555 } } };
    await post(url + '?secret=hook-secret', update);
    await post(url + '?secret=hook-secret', update);
    assert.strictEqual(ctx.fetches.length, 1);
  } finally { server.close(); }
});

test('sendTelegram_: без токена/чата возвращает 0; с настройками — HTTP-код Bot API', async () => {
  const ctx = makeCtx();
  // BOT_TOKEN есть (env), чата нет
  assert.strictEqual(await ctx.telegram.sendTelegram_(null, 'x'), 0);
  // Явный chat_id
  assert.strictEqual(await ctx.telegram.sendTelegram_(123, 'привет'), 200);
  assert.strictEqual(ctx.fetches[0].payload.chat_id, 123);
  // Не-200 от Bot API прокидывается (для digest_sent)
  ctx.setFetchStatus(500);
  assert.strictEqual(await ctx.telegram.sendTelegram_(123, 'x'), 500);
});

test('buildDigestText_: итоги дня + незавершённые для открытой смены', () => {
  const ctx = makeCtx();
  const owner = loginOwner();
  const clientId = ctx.api.saveClient(owner, { name: 'Отель А' }).client.id;
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, '2026-08-13').wash.id;
  ctx.api.startWash(owner, washId); // in_progress — незавершённая
  const text = ctx.telegram.buildDigestText_(TODAY);
  assert.ok(text.includes('итоги ' + TODAY));
  assert.ok(text.includes('стирок не было'));
  assert.ok(text.includes('⚠ Смена ещё не закрыта'));
  assert.ok(text.includes('Незавершённые: Отель А'));
});

test('sendDigestLocked_: digest_sent=да только после HTTP 200, повторно не шлёт', async () => {
  const ctx = makeCtx();
  ctx.db.appendRow_('Settings', { key: 'OWNER_CHAT_ID', value: '998877' });
  ctx.db.invalidateRefCache_();

  // Bot API вернул 500 → флаг не ставится
  ctx.setFetchStatus(500);
  assert.strictEqual(await ctx.telegram.sendDigestLocked_(TODAY), false);
  let shift = ctx.db.readAll_('Shifts').find(s => s.date === TODAY);
  assert.ok(!shift || shift.digest_sent !== 'да');

  // 200 → флаг ставится, смена создана при необходимости
  ctx.setFetchStatus(200);
  assert.strictEqual(await ctx.telegram.sendDigestLocked_(TODAY), true);
  shift = ctx.db.readAll_('Shifts').find(s => s.date === TODAY);
  assert.strictEqual(shift.digest_sent, 'да');

  // Повторный вызов не шлёт
  const before = ctx.fetches.length;
  assert.strictEqual(await ctx.telegram.sendDigestLocked_(TODAY), false);
  assert.strictEqual(ctx.fetches.length, before);
});

test('fallbackDigestTrigger: шлёт, только если смена не закрыта', async () => {
  const ctx = makeCtx();
  ctx.db.appendRow_('Settings', { key: 'OWNER_CHAT_ID', value: '998877' });
  ctx.db.invalidateRefCache_();
  const owner = loginOwner();
  const clientId = ctx.api.saveClient(owner, { name: 'Отель А' }).client.id;
  const washId = ctx.api.addToDelivery(owner, clientId, TODAY, '2026-08-13').wash.id;
  ctx.api.startWash(owner, washId);
  ctx.api.completeWash(owner, washId, [{ item_type_id: 'itm_1', qty: 1 }], 5);

  // Смена не закрыта → fallback отправляет дайджест
  await ctx.telegram.fallbackDigestTrigger();
  assert.strictEqual(ctx.fetches.length, 1);

  // Закрываем смену: fallback уже отправил → только короткое подтверждение
  const closed = await ctx.api.closeShift(owner);
  assert.ok(closed.ok);
  assert.strictEqual(ctx.fetches.length, 2);
  assert.ok(ctx.fetches[1].payload.text.includes('Смена закрыта в 21:30 ✓'));

  // После закрытия fallback молчит
  await ctx.telegram.fallbackDigestTrigger();
  assert.strictEqual(ctx.fetches.length, 2);
});
