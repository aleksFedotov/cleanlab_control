const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadGs } = require('./helpers/loadGs');

const ROOT = path.join(__dirname, '..');

test('appsscript.json валиден и содержит Europe/Moscow', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'appsscript.json'), 'utf8'));
  assert.equal(manifest.timeZone, 'Europe/Moscow');
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.ok(manifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.currentonly'));
});

test('loadGs выполняет .gs-файл и возвращает его функции', () => {
  const fixture = path.join(ROOT, 'src', '_fixture_tmp.gs');
  fs.writeFileSync(fixture, 'function add(a, b) { return a + b; }');
  try {
    const ctx = loadGs('_fixture_tmp.gs');
    assert.equal(ctx.add(2, 3), 5);
  } finally {
    fs.unlinkSync(fixture);
  }
});
