// Типизированные ключи TanStack Query. Инвалидация после мутаций — по этим ключам.
export const qk = {
  dayList: (date: string) => ['dayList', date] as const,
  deliveryVisits: (date: string) => ['deliveryVisits', date] as const,
  weekPlan: (weekStart: string) => ['weekPlan', weekStart] as const,
  storage: () => ['storage'] as const,
  dayReport: (date: string) => ['dayReport', date] as const,
  refs: () => ['refs'] as const,
  users: () => ['users'] as const,
  laundries: () => ['laundries'] as const,
  driverRoute: (date: string) => ['driverRoute', date] as const,
  shiftCloseState: (date: string) => ['shiftCloseState', date] as const,
};

// Что инвалидировать после операционных мутаций (стирка/развоз/склад взаимосвязаны).
export const OPERATIONAL_PREFIXES = ['dayList', 'deliveryVisits', 'weekPlan', 'storage', 'dayReport', 'driverRoute', 'shiftCloseState'];
