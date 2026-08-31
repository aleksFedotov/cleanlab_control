// Типизированные ключи TanStack Query. Инвалидация после мутаций — по этим ключам.
export const qk = {
  dayList: (date: string) => ['dayList', date] as const,
  deliveryVisits: (date: string) => ['deliveryVisits', date] as const,
  weekPlan: (weekStart: string) => ['weekPlan', weekStart] as const,
  storage: () => ['storage'] as const,
  dayReport: (date: string) => ['dayReport', date] as const,
  financeSummary: (from: string, to: string) => ['financeSummary', from, to] as const,
  refs: () => ['refs'] as const,
  users: () => ['users'] as const,
  laundries: () => ['laundries'] as const,
  driverRoute: (date: string) => ['driverRoute', date] as const,
  shiftCloseState: (date: string) => ['shiftCloseState', date] as const,
  workHours: (from: string, to: string) => ['workHours', from, to] as const,
  deliveryPointStats: (from: string, to: string) => ['deliveryPointStats', from, to] as const,
  billingItems: () => ['billingItems'] as const,
  tariffs: (clientId?: string) => ['tariffs', clientId || ''] as const,
  clientItemBilling: (clientId: string) => ['clientItemBilling', clientId] as const,
  invoice: (clientId: string, from: string, to: string) => ['invoice', clientId, from, to] as const,
  payroll: (from: string, to: string) => ['payroll', from, to] as const,
  payRates: () => ['payRates'] as const,
  myPayroll: (from: string, to: string) => ['myPayroll', from, to] as const,
  payAdjustments: (userId?: string, from?: string, to?: string) =>
    ['payAdjustments', userId || '', from || '', to || ''] as const,
};

// Что инвалидировать после операционных мутаций (стирка/развоз/склад взаимосвязаны).
export const OPERATIONAL_PREFIXES = ['dayList', 'deliveryVisits', 'weekPlan', 'storage', 'dayReport', 'financeSummary', 'driverRoute', 'shiftCloseState', 'workHours', 'deliveryPointStats'];
