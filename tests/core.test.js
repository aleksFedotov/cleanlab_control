// Тесты T3: правила ядра из spec §4, §8.2 — переходы, done/stored, перенос,
// блокировка закрытия, агрегаты отчёта, формат дайджеста.
const test = require('node:test');
const assert = require('node:assert');
const { loadGs } = require('./helpers/loadGs');

const core = loadGs('Core.gs', {});
const wash = (over) => Object.assign({
  id: 'wash_1', client_id: 'cli_1', wash_date: '2026-08-12', issue_date: '2026-08-13',
  status: 'planned', dirty_weight_kg: 0, items_total: 0, deferred_from: '', deferred_reason: ''
}, over);

test('правило done/stored: issue_date > wash_date + 1 → stored', () => {
  assert.strictEqual(core.completionStatus_('2026-08-12', '2026-08-13'), 'done');
  assert.strictEqual(core.completionStatus_('2026-08-12', '2026-08-12'), 'done');
  assert.strictEqual(core.completionStatus_('2026-08-12', '2026-08-14'), 'stored');
  // Переход месяца и года
  assert.strictEqual(core.completionStatus_('2026-01-31', '2026-02-01'), 'done');
  assert.strictEqual(core.completionStatus_('2026-12-31', '2027-01-02'), 'stored');
});

test('переходы статусов: валидные и отклонение невалидных', () => {
  assert.ok(core.checkTransition_('start', wash({ status: 'planned' })).ok);
  assert.ok(core.checkTransition_('complete', wash({ status: 'in_progress' })).ok);
  assert.ok(core.checkTransition_('issue', wash({ status: 'done' })).ok);
  assert.ok(core.checkTransition_('issue', wash({ status: 'stored' })).ok);
  assert.ok(core.checkTransition_('cancel', wash({ status: 'planned' })).ok);
  assert.ok(core.checkTransition_('defer', wash({ status: 'in_progress' })).ok);

  assert.ok(!core.checkTransition_('start', wash({ status: 'in_progress' })).ok);
  assert.ok(!core.checkTransition_('complete', wash({ status: 'planned' })).ok);
  assert.ok(!core.checkTransition_('issue', wash({ status: 'issued' })).ok);
  assert.ok(!core.checkTransition_('cancel', wash({ status: 'done' })).ok);
  assert.ok(!core.checkTransition_('defer', wash({ status: 'done' })).ok);
});

test('идемпотентность: повторные действия отклоняются', () => {
  // Повторное «В работу» после start, повторное «Завершить» после complete
  assert.ok(!core.checkTransition_('start', wash({ status: 'in_progress' })).ok);
  assert.ok(!core.checkTransition_('complete', wash({ status: 'done' })).ok);
  assert.ok(!core.checkTransition_('complete', wash({ status: 'stored' })).ok);
});

test('перенос сохраняет вес и статус, пишет deferred_from', () => {
  const w = wash({ status: 'in_progress', dirty_weight_kg: 15.5, wash_date: '2026-08-12' });
  const patch = JSON.parse(JSON.stringify(core.applyDefer_(w, '2026-08-14', 'не успели')));
  assert.deepStrictEqual(patch, {
    wash_date: '2026-08-14', deferred_from: '2026-08-12', deferred_reason: 'не успели'
  });
  assert.strictEqual(w.status, 'in_progress'); // исходник не мутируется
  // Цепочка: второй перенос пишет последнюю исходную дату
  const w2 = Object.assign({}, w, patch);
  assert.strictEqual(core.applyDefer_(w2, '2026-08-15').deferred_from, '2026-08-14');
});

test('список дня: отбор и сортировка (незавершённые впереди)', () => {
  const list = [
    wash({ id: 'wash_1', status: 'done' }),
    wash({ id: 'wash_2', status: 'planned' }),
    wash({ id: 'wash_3', status: 'issued' }),   // терминальный — не в списке
    wash({ id: 'wash_4', status: 'cancelled' }), // терминальный — не в списке
    wash({ id: 'wash_5', status: 'in_progress' }),
    wash({ id: 'wash_6', wash_date: '2026-08-13' }) // другой день — не в списке
  ];
  const day = list.filter(w => core.isDayWash_(w, '2026-08-12'));
  assert.deepStrictEqual(day.map(w => w.id), ['wash_1', 'wash_2', 'wash_5']);
  const sorted = core.sortDayList_(day);
  assert.deepStrictEqual(sorted.map(w => w.id), ['wash_2', 'wash_5', 'wash_1']);
});

test('блокировка закрытия смены: только planned/in_progress сегодняшнего дня', () => {
  const washes = [
    wash({ id: 'wash_1', status: 'planned' }),
    wash({ id: 'wash_2', status: 'in_progress' }),
    wash({ id: 'wash_3', status: 'done' }),
    wash({ id: 'wash_4', status: 'stored' }),
    wash({ id: 'wash_5', status: 'planned', wash_date: '2026-08-13' }) // перенесена на завтра
  ];
  const blockers = core.shiftBlockers_(washes, '2026-08-12');
  assert.deepStrictEqual(blockers.map(w => w.id), ['wash_1', 'wash_2']);
});

test('правка данных: owner всегда, worker — только при открытой смене', () => {
  const done = wash({ status: 'done' });
  assert.ok(core.canEditWashData_('owner', done, { status: 'closed' }));
  assert.ok(core.canEditWashData_('worker', done, { status: 'open' }));
  assert.ok(!core.canEditWashData_('worker', done, { status: 'closed' }));
  assert.ok(!core.canEditWashData_('owner', wash({ status: 'planned' }), null));
});

test('агрегаты отчёта за день (spec §8.2)', () => {
  const date = '2026-08-12';
  const washes = [
    wash({ id: 'w1', status: 'done', dirty_weight_kg: 10.5 }),
    wash({ id: 'w2', status: 'stored', dirty_weight_kg: 5.25 }),
    wash({ id: 'w3', status: 'issued', dirty_weight_kg: 4, issued_at: '2026-08-12 15:00:00' }),
    wash({ id: 'w4', status: 'issued', dirty_weight_kg: 8, issued_at: '2026-08-13 10:00:00' }), // выдана завтра
    wash({ id: 'w5', status: 'cancelled', dirty_weight_kg: 0 }),
    wash({ id: 'w6', status: 'planned' }) // не завершена — в кг не входит
  ];
  const log = [
    { action: 'wash_defer', details: JSON.stringify({ from: date, to: '2026-08-13' }) },
    { action: 'wash_defer', details: JSON.stringify({ from: '2026-08-11', to: date }) }, // перенос В этот день — не считается
    { action: 'wash_done', details: '{}' }
  ];
  const r = core.buildDayReport_(date, washes, log);
  assert.strictEqual(r.totalKg, 27.8); // 10.5 + 5.25 + 4 + 8: issued входит в кг по wash_date (spec §8.2)
  assert.strictEqual(r.washesDone, 4);
  assert.strictEqual(r.deferred, 1);
  assert.strictEqual(r.cancelled, 1);
  assert.strictEqual(r.stored, 1);
  assert.strictEqual(r.issued, 1); // только issued_at внутри даты
});

test('формат дайджеста: полный и пустой день', () => {
  const report = { totalKg: 19.8, washesDone: 2, deferred: 1, cancelled: 0, stored: 1, issued: 0 };
  const d = core.formatDigest_('Прачка360', '2026-08-12', report, ['• Отель — 10 кг, 40 шт'], { status: 'closed', closed_at: '21:30' });
  assert.match(d, /📊 Прачка360 — итоги 2026-08-12/);
  assert.match(d, /19\.8 кг \(2 стирок\)/);
  assert.match(d, /Перенесено: 1/);
  assert.match(d, /На складе: 1/);
  assert.match(d, /• Отель — 10 кг, 40 шт/);
  assert.match(d, /Смена закрыта в 21:30 ✓/);

  const empty = core.formatDigest_('Прачка360', '2026-08-12', { washesDone: 0 }, [], null);
  assert.match(empty, /За 2026-08-12 стирок не было/);
  assert.match(empty, /⚠ Смена ещё не закрыта/);
});
