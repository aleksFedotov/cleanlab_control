// Форматирование дат в Europe/Moscow — замена Utilities.formatDate + Session.getScriptTimeZone.
// Форматы, используемые в проекте: 'yyyy-MM-dd', 'HH:mm', 'yyyy-MM-dd HH:mm:ss'.
const TZ = process.env.APP_TZ || 'Europe/Moscow';

const dtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false
});

function parts(date) {
  const out = {};
  for (const p of dtf.formatToParts(date)) {
    // '24' → '00' только для часа (Intl при hour12:false может отдать '24').
    // Раньше замена применялась ко всем частям — 24-го числа дата ломалась в '…-08-00'.
    if (p.type !== 'literal') out[p.type] = p.type === 'hour' && p.value === '24' ? '00' : p.value;
  }
  return out;
}

function formatDate(date, fmt) {
  const p = parts(date);
  const ymd = `${p.year}-${p.month}-${p.day}`;
  if (fmt === 'yyyy-MM-dd') return ymd;
  if (fmt === 'HH:mm') return `${p.hour}:${p.minute}`;
  return `${ymd} ${p.hour}:${p.minute}:${p.second}`;
}

// Источник «сейчас» — подменяемый для тестов (_setNowForTests).
let nowProvider = () => new Date();

function now() { return formatDate(nowProvider(), 'yyyy-MM-dd HH:mm:ss'); }
function today() { return formatDate(nowProvider(), 'yyyy-MM-dd'); }
function nowHHMM() { return formatDate(nowProvider(), 'HH:mm'); }

// Для тестов: зафиксировать «сейчас» (Date) или вернуть реальное время (null).
function _setNowForTests(dateOrNull) {
  nowProvider = dateOrNull ? () => new Date(dateOrNull) : () => new Date();
}

module.exports = { TZ, formatDate, now, today, nowHHMM, _setNowForTests };
