'use client';

import { useUiStore } from '@/stores/ui';
import { todayStr } from '@/lib/dates';

// Выбранная дата раздела ('today' | 'wash' | 'plan' | 'report'), дефолт — сегодня.
// Хранится в Zustand, чтобы DateNav в хедере layout'а и страница видели одно значение.
export function useSectionDate(section: string): [string, (d: string) => void] {
  const date = useUiStore((s) => s.dates[section]);
  const setDate = useUiStore((s) => s.setDate);
  return [date || todayStr(), (d: string) => setDate(section, d)];
}
