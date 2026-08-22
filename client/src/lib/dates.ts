// Даты: порты из server/public/index.html + форматирование по-русски.
// Формат даты везде 'yyyy-MM-dd' (строка, без таймзонных сдвигов — считаем через UTC).

export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function parse(dateStr: string): Date {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}

function fmt(dt: Date): string {
  const d = dt.getUTCDate();
  const m = dt.getUTCMonth() + 1;
  return `${dt.getUTCFullYear()}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Сегодня (локальная дата пользователя) в 'yyyy-MM-dd'
export function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// Сдвиг 'yyyy-MM-dd' на N дней
export function shiftDateStr(dateStr: string, days: number): string {
  return fmt(new Date(parse(dateStr).getTime() + days * 86400000));
}

// Понедельник недели, содержащей дату
export function mondayOf(dateStr: string): string {
  const dt = parse(dateStr);
  const dow = (dt.getUTCDay() + 6) % 7; // Пн=0
  return fmt(new Date(dt.getTime() - dow * 86400000));
}

// День недели (Пн..Вс) для 'yyyy-MM-dd'
export function weekdayOf(dateStr: string): string {
  return WEEKDAYS[(parse(dateStr).getUTCDay() + 6) % 7];
}

// 'HH:MM' из 'yyyy-MM-dd HH:mm:ss' (пустая строка, если формата нет)
export function timeOf(s: string | null | undefined): string {
  return (s || '').length >= 16 ? String(s).slice(11, 16) : '';
}

// «21 августа 2026»
export function formatDateRu(dateStr: string, withYear = true): string {
  const dt = parse(dateStr);
  const base = `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
  return withYear ? `${base} ${dt.getUTCFullYear()}` : base;
}

// «17–23 августа» / «29 сентября – 5 октября»
export function formatWeekRu(weekStart: string): string {
  const end = shiftDateStr(weekStart, 6);
  const a = parse(weekStart);
  const b = parse(end);
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]}`;
  }
  return `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]}`;
}

export function isToday(dateStr: string): boolean {
  return dateStr === todayStr();
}
