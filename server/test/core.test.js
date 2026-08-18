// Тесты чистого ядра server/core.js — грани поведения src/Core.gs.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../core');

test('addDaysStr_/mondayOf_: строковая арифметика дат без TZ', () => {
  assert.strictEqual(core.addDaysStr_('2026-08-12', 1), '2026-08-13');
  assert.strictEqual(core.addDaysStr_('2026-08-01', -1), '2026-07-31');
  assert.strictEqual(core.addDaysStr_('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(core.mondayOf_('2026-08-12'), '2026-08-10'); // среда → понедельник
  assert.strictEqual(core.mondayOf_('2026-08-10'), '2026-08-10'); // понедельник → он сам
  assert.strictEqual(core.mondayOf_('2026-08-16'), '2026-08-10'); // воскресенье → тот же пн
});

test('completionStatus_: выдача позже wash_date+1 → stored, иначе done', () => {
  assert.strictEqual(core.completionStatus_('2026-08-12', '2026-08-13'), 'done');
  assert.strictEqual(core.completionStatus_('2026-08-12', '2026-08-14'), 'stored');
});

test('checkTransition_: допустимые переходы и отказ с русским сообщением', () => {
  assert.ok(core.checkTransition_('start', { status: 'planned' }).ok);
  assert.ok(core.checkTransition_('start', { status: 'no_linen' }).ok);
  assert.ok(!core.checkTransition_('start', { status: 'in_progress' }).ok);
  assert.ok(!core.checkTransition_('complete', { status: 'planned' }).ok);
  const nf = core.checkTransition_('start', null);
  assert.strictEqual(nf.error, 'Стирка не найдена');
  assert.strictEqual(core.checkTransition_('cancel', { status: 'done' }).error, 'Нельзя cancel из статуса done');
});

test('applyDefer_: статус и вес не трогаем, след переноса', () => {
  const patch = core.applyDefer_({ wash_date: '2026-08-12', status: 'planned' }, '2026-08-14', 'нет места');
  assert.deepStrictEqual(patch, { wash_date: '2026-08-14', deferred_from: '2026-08-12', deferred_reason: 'нет места' });
});

test('canEditWashData_: owner всегда, worker — пока смена открыта, только done/stored/partial', () => {
  const w = { status: 'done' };
  assert.ok(core.canEditWashData_('owner', w, null));
  assert.ok(core.canEditWashData_('worker', w, { status: 'open' }));
  assert.ok(!core.canEditWashData_('worker', w, { status: 'closed' }));
  assert.ok(!core.canEditWashData_('owner', { status: 'planned' }, null));
});

test('sortDayList_: сначала открытые (planned/in_progress), затем остальные', () => {
  const sorted = core.sortDayList_([
    { status: 'done' }, { status: 'planned' }, { status: 'in_progress' }, { status: 'stored' }
  ]);
  assert.deepStrictEqual(sorted.map(w => w.status), ['planned', 'in_progress', 'done', 'stored']);
});

test('shiftBlockers_: блокируют только planned/in_progress сегодняшнего дня', () => {
  const blockers = core.shiftBlockers_([
    { wash_date: '2026-08-12', status: 'planned' },
    { wash_date: '2026-08-12', status: 'in_progress' },
    { wash_date: '2026-08-12', status: 'done' },
    { wash_date: '2026-08-12', status: 'no_linen' },
    { wash_date: '2026-08-13', status: 'planned' }
  ], '2026-08-12');
  assert.strictEqual(blockers.length, 2);
});

test('buildDayReport_: кг по DONE_STATUSES, issued по issued_at, переносы по событиям', () => {
  const washes = [
    { wash_date: '2026-08-12', status: 'done', dirty_weight_kg: '10.5' },
    { wash_date: '2026-08-12', status: 'stored', dirty_weight_kg: '5' },
    { wash_date: '2026-08-12', status: 'cancelled' },
    { wash_date: '2026-08-12', status: 'issued', dirty_weight_kg: '3', issued_at: '2026-08-12 18:00:00' },
    { wash_date: '2026-08-12', status: 'planned' }
  ];
  const log = [
    { action: 'wash_defer', details: JSON.stringify({ from: '2026-08-12', to: '2026-08-13' }) },
    { action: 'wash_defer', details: JSON.stringify({ from: '2026-08-11', to: '2026-08-12' }) }
  ];
  const r = core.buildDayReport_('2026-08-12', washes, log);
  assert.deepStrictEqual(r, {
    date: '2026-08-12', totalKg: 18.5, washesDone: 3, deferred: 1,
    cancelled: 1, stored: 2, issued: 1
  });
});

test('formatDigest_: пустой день и закрытая/открытая смена', () => {
  const empty = core.formatDigest_('Прачка360', '2026-08-12', { washesDone: 0 }, [], null);
  assert.ok(empty.includes('стирок не было'));
  assert.ok(empty.includes('⚠ Смена ещё не закрыта'));
  const closed = core.formatDigest_('Прачка360', '2026-08-12',
    { washesDone: 2, totalKg: 20, deferred: 1, cancelled: 0, stored: 1, issued: 1 },
    ['• Клиент — 20 кг, 10 шт'], { status: 'closed', closed_at: '21:30' });
  assert.ok(closed.includes('Постирано: 20 кг (2 стирок)'));
  assert.ok(closed.includes('Смена закрыта в 21:30 ✓'));
});
