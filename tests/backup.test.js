// Тесты T9: бэкап с ротацией до 30 копий, идемпотентная установка триггеров.
const test = require('node:test');
const assert = require('node:assert');
const { makeApiCtx } = require('./helpers/gasMocks');
const { loadGs } = require('./helpers/loadGs');

function makeFile(name, created) {
  return { name, created, trashed: false,
    getDateCreated() { return this.created; },
    setTrashed(v) { this.trashed = v; },
    makeCopy(newName, folder) {
      const copy = makeFile(newName, new Date('2026-08-12T21:30:00Z'));
      folder.files.push(copy);
      return copy;
    } };
}

function makeFolder(name) {
  return {
    name, files: [], subfolders: [],
    getFiles() { let i = 0; const f = this.files; return { hasNext: () => i < f.length, next: () => f[i++] }; },
    getFoldersByName(n) { let i = 0; const f = this.subfolders.filter(s => s.name === n);
      return { hasNext: () => i < f.length, next: () => f[i++] }; },
    createFolder(n) { const sub = makeFolder(n); this.subfolders.push(sub); return sub; }
  };
}

function makeBackupCtx() {
  const base = makeApiCtx();
  const root = makeFolder('Прачка360');
  const spreadsheetFile = makeFile('Прачка360 БД', new Date('2026-01-01T00:00:00Z'));
  base.ctx.DriveApp = {
    getFoldersByName: n => ({ hasNext: () => n === root.name, next: () => root }),
    createFolder: n => makeFolder(n),
    getFileById: () => spreadsheetFile
  };
  base.ctx.SpreadsheetApp.getActiveSpreadsheet = () => ({
    getId: () => 'ss-1', getName: () => 'Прачка360 БД',
    getSheetByName: n => base.ss.getSheetByName(n)
  });
  loadGs('Backup.gs', base.ctx);
  return { ...base, root, spreadsheetFile };
}

test('backupDaily: копия с датой в Прачка360/backups, ротация до 30', () => {
  const { ctx, root } = makeBackupCtx();
  // Пре-существующие 31 копия
  const backups = root.createFolder('backups');
  for (let i = 1; i <= 31; i++) {
    backups.files.push(makeFile(`old ${i}`, new Date(2026, 0, i)));
  }
  ctx.backupDaily();
  assert.strictEqual(backups.files.length, 32);
  const fresh = backups.files.find(f => f.name === 'Прачка360 БД — backup 2026-08-12');
  assert.ok(fresh, 'свежая копия с датой создана');
  // Две самые старые — в корзине, хранится 30
  assert.strictEqual(backups.files.filter(f => f.trashed).length, 2);
  assert.strictEqual(backups.files.filter(f => !f.trashed).length, 30);
  assert.ok(!fresh.trashed);
  assert.ok(backups.files.find(f => f.name === 'old 1').trashed);
  assert.ok(backups.files.find(f => f.name === 'old 2').trashed);
});

test('installTriggers: создаёт оба триггера и идемпотентна', () => {
  const { ctx } = makeBackupCtx();
  let triggers = [];
  const mkTrigger = fn => ({
    fn, spec: {},
    getHandlerFunction() { return this.fn; },
    timeBased() { return this; },
    everyDays() { return this; },
    atHour(h) { this.spec.hour = h; return this; },
    nearMinute(m) { this.spec.minute = m; return this; },
    create() { triggers.push(this); return this; }
  });
  ctx.ScriptApp = {
    newTrigger: fn => mkTrigger(fn),
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger: t => { triggers = triggers.filter(x => x !== t); }
  };

  ctx.installTriggers();
  assert.deepStrictEqual(triggers.map(t => t.fn).sort(), ['backupDaily', 'fallbackDigestTrigger']);
  const digest = triggers.find(t => t.fn === 'fallbackDigestTrigger');
  assert.strictEqual(digest.spec.hour, 21); // DIGEST_TIME из Settings = 21:30
  assert.strictEqual(digest.spec.minute, 30);
  // Повторная установка не дублирует
  ctx.installTriggers();
  assert.strictEqual(triggers.length, 2);
});
