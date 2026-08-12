// Эксплуатация: ежедневный бэкап и установка триггеров (spec §10).
var BACKUP_KEEP = 30;
var BACKUP_ROOT = 'Прачка360';
var BACKUP_SUB = 'backups';
var TRIGGER_FUNCTIONS = ['fallbackDigestTrigger', 'backupDaily'];

// Копия таблицы в Прачка360/backups с именем с датой + ротация до 30 копий.
function backupDaily() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var folder = backupsFolder_();
  DriveApp.getFileById(ss.getId()).makeCopy(ss.getName() + ' — backup ' + todayStr_(), folder);
  rotateBackups_(folder, BACKUP_KEEP);
}

function backupsFolder_() {
  var it = DriveApp.getFoldersByName(BACKUP_ROOT);
  var root = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_ROOT);
  var sub = root.getFoldersByName(BACKUP_SUB);
  return sub.hasNext() ? sub.next() : root.createFolder(BACKUP_SUB);
}

// Храним последние keep копий, остальные — в корзину.
function rotateBackups_(folder, keep) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) files.push(it.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  for (var i = keep; i < files.length; i++) files[i].setTrashed(true);
}

// Идемпотентная установка time-триггеров: старые наши триггеры снимаются, затем создаются заново.
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (TRIGGER_FUNCTIONS.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  // Fallback-дайджест на DIGEST_TIME из Settings
  var digestTime = (getSettings_().DIGEST_TIME || '21:30').split(':');
  ScriptApp.newTrigger('fallbackDigestTrigger').timeBased()
    .everyDays(1).atHour(Number(digestTime[0])).nearMinute(Number(digestTime[1])).create();
  // Ежедневный бэкап ночью
  ScriptApp.newTrigger('backupDaily').timeBased()
    .everyDays(1).atHour(3).nearMinute(40).create();
}
