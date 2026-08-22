// Форматирование величин: кг/шт/мешки. БД местами хранит числа строками и ''.

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// «18 кг»; пустое значение → '—'
export function kg(v: unknown): string {
  if (v === '' || v === null || v === undefined) return '—';
  return `${num(v)} кг`;
}

// «3 мешка» с правильным склонением
export function bags(n: number): string {
  return `${n} ${plural(n, 'мешок', 'мешка', 'мешков')}`;
}

export function items(n: number): string {
  return `${n} ${plural(n, 'позиция', 'позиции', 'позиций')}`;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m = Math.abs(n) % 100;
  const d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}
