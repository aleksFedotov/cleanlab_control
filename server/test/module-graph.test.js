// R5: smoke-тест одностороннего графа модулей — ловит статические циклы require.
// Статический цикл проявляется как частично инициализированные экспорты,
// поэтому каждый модуль требуем в изолированном процессе (exit code 0),
// а затем в основном процессе проверяем typeof ключевых экспортов.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MODULES = ['visits', 'wash', 'deliveries', 'payroll', 'api/users', 'api/washes', 'tg-send', 'telegram', 'api'];

for (const name of MODULES) {
  test(`изолированный require: ${name}`, () => {
    const res = spawnSync(process.execPath, ['-e', `require('./${name}')`], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0, `require('./${name}') упал:\n${res.stderr}`);
  });
}

const KEY_EXPORTS = {
  visits: ['isOpenVisit_', 'getVisitsByDate_', 'ensureVisit_'],
  wash: ['startWash', 'notReadyForDelivery_', 'issueForVisit_', 'unissueForVisit_', 'notifyOwnerOnWorkerAction_'],
  deliveries: ['getDeliveryVisits', 'getVisitsByDate_', 'ensureVisit_', 'isOpenVisit_'],
  payroll: ['computePayroll_', 'addExtraWork'],
  'api/users': ['consumeTelegramBindCode_'],
  'api/washes': ['ensureWashesFromDelivery_'],
  'tg-send': ['getOwnerChatId_', 'sendTelegram_', 'buildDigestText_', 'sendDigestLocked_'],
  telegram: ['mountTelegram', 'sendTelegram_', 'sendDigestLocked_', 'buildDigestText_', 'getOwnerChatId_'],
  api: ['mountApi']
};

test('ключевые экспорты — функции (нет частично инициализированных модулей)', () => {
  for (const [name, keys] of Object.entries(KEY_EXPORTS)) {
    const mod = require('../' + name);
    for (const key of keys) {
      assert.strictEqual(typeof mod[key], 'function', `${name}.${key} — не функция (статический цикл require?)`);
    }
  }
});
