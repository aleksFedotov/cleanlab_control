// item_types в БД — JSON-массив id строкой или '' (legacy JSON.parse(c.item_types || '[]')).
export function parseItemTypes(s: string): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
