// Типизированные ключи TanStack Query. Инвалидация после мутаций — по этим ключам.
export const qk = {
  dayList: (date: string) => ['dayList', date] as const,
  deliveryVisits: (date: string) => ['deliveryVisits', date] as const,
  weekPlan: (weekStart: string) => ['weekPlan', weekStart] as const,
  storage: () => ['storage'] as const,
  dayReport: (date: string) => ['dayReport', date] as const,
  summaryReport: (from: string, to: string) => ['summaryReport', from, to] as const,
  refs: () => ['refs'] as const,
  users: () => ['users'] as const,
  laundries: () => ['laundries'] as const,
  driverRoute: (date: string) => ['driverRoute', date] as const,
  shiftCloseState: (date: string) => ['shiftCloseState', date] as const,
  workHours: (from: string, to: string) => ['workHours', from, to] as const,
  deliveryPointStats: (from: string, to: string) => ['deliveryPointStats', from, to] as const,
};

// Что инвалидировать после операционных мутаций (стирка/развоз/склад взаимосвязаны).
export const OPERATIONAL_PREFIXES = ['dayList', 'deliveryVisits', 'weekPlan', 'storage', 'dayReport', 'summaryReport', 'driverRoute', 'shiftCloseState', 'workHours', 'deliveryPointStats'];
