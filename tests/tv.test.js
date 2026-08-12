// Тест T8: маршрутизация doGet — TV по верному ключу, PIN-форма иначе.
const test = require('node:test');
const assert = require('node:assert');
const { makeApiCtx } = require('./helpers/gasMocks');
const { loadGs } = require('./helpers/loadGs');

test('doGet: верный TV-ключ → Tv.html, неверный/отсутствующий → Index.html', () => {
  const { ctx } = makeApiCtx();
  ctx.HtmlService = {
    createHtmlOutputFromFile: name => ({
      file: name,
      setTitle() { return this; },
      addMetaTag() { return this; }
    })
  };
  loadGs('Main.gs', ctx);

  assert.strictEqual(ctx.doGet({ parameter: { tv: '1', key: 'tv-secret' } }).file, 'Tv');
  assert.strictEqual(ctx.doGet({ parameter: { tv: '1', key: 'wrong' } }).file, 'Index');
  assert.strictEqual(ctx.doGet({ parameter: {} }).file, 'Index');
  assert.strictEqual(ctx.doGet(undefined).file, 'Index');
});
