'use client';

// TanStack Query обёртки над lib/api.ts. Серверное состояние — только через эти хуки.
// Все чтения подставляют токен из сессии; компоненты токен не трогают.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { qk, OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { useUiStore } from '@/stores/ui';
import type {
  DayListRes, DeliveryVisitsRes, WeekPlanRes, StorageRes, DayReportRes, FinanceSummaryRes,
  RefsRes, UsersRes, LaundriesRes, DriverRouteRes, ShiftCloseStateRes,
  WorkHoursRes, DeliveryPointStatsRes,
  BillingItemsRes, TariffsRes, ClientItemBillingRes, InvoiceRes,
  PayrollRes, PayRatesRes, PaySettingsRes, MyPayrollRes, PayAdjustmentRes, PayAdjustmentsListRes,
} from '@/types/api';

function token(): string {
  return getSession()?.token || '';
}

// --- Чтения ---

export function useDayList(date: string) {
  return useQuery({
    queryKey: qk.dayList(date),
    queryFn: () => api<DayListRes>('getDayList', token(), date),
    enabled: !!token(),
  });
}

export function useDeliveryVisits(date: string) {
  return useQuery({
    queryKey: qk.deliveryVisits(date),
    queryFn: () => api<DeliveryVisitsRes>('getDeliveryVisits', token(), date),
    enabled: !!token(),
  });
}

export function useWeekPlan(weekStart: string) {
  return useQuery({
    queryKey: qk.weekPlan(weekStart),
    queryFn: () => api<WeekPlanRes>('getWeekPlan', token(), weekStart),
    enabled: !!token(),
  });
}

export function useStorage() {
  return useQuery({
    queryKey: qk.storage(),
    queryFn: () => api<StorageRes>('getStorage', token()),
    enabled: !!token(),
  });
}

export function useDayReport(date: string) {
  return useQuery({
    queryKey: qk.dayReport(date),
    queryFn: () => api<DayReportRes>('getDayReport', token(), date),
    enabled: !!token(),
  });
}

// Начисления по клиентам за период (P4, owner-only)
export function useFinanceSummary(from: string, to: string) {
  return useQuery({
    queryKey: qk.financeSummary(from, to),
    queryFn: () => api<FinanceSummaryRes>('getFinanceSummary', token(), from, to),
    enabled: !!token() && !!from && !!to,
  });
}

export function useRefs() {
  return useQuery({
    queryKey: qk.refs(),
    queryFn: () => api<RefsRes>('getRefs', token()),
    enabled: !!token(),
  });
}

export function useUsers() {
  return useQuery({
    queryKey: qk.users(),
    queryFn: () => api<UsersRes>('listUsers', token()),
    enabled: !!token(),
  });
}

export function useLaundries() {
  return useQuery({
    queryKey: qk.laundries(),
    queryFn: () => api<LaundriesRes>('listLaundries', token()),
    enabled: !!token(),
  });
}

export function useDriverRoute(date: string) {
  return useQuery({
    queryKey: qk.driverRoute(date),
    queryFn: () => api<DriverRouteRes>('getDriverRoute', token(), date),
    enabled: !!token(),
  });
}

// getShiftCloseState не принимает date — всегда «сегодня»
export function useShiftCloseState(enabled = true) {
  return useQuery({
    queryKey: qk.shiftCloseState('today'),
    queryFn: () => api<ShiftCloseStateRes>('getShiftCloseState', token()),
    enabled: enabled && !!token(),
  });
}

export function useWorkHours(from: string, to: string) {
  return useQuery({
    queryKey: qk.workHours(from, to),
    queryFn: () => api<WorkHoursRes>('getWorkHours', token(), from, to),
    enabled: !!token() && !!from && !!to,
  });
}

export function useDeliveryPointStats(from: string, to: string) {
  return useQuery({
    queryKey: qk.deliveryPointStats(from, to),
    queryFn: () => api<DeliveryPointStatsRes>('getDeliveryPointStats', token(), from, to),
    enabled: !!token() && !!from && !!to,
  });
}

// --- Прайс и счета (P2, owner-only) ---

export function useBillingItems() {
  return useQuery({
    queryKey: qk.billingItems(),
    queryFn: () => api<BillingItemsRes>('listBillingItems', token()),
    enabled: !!token(),
  });
}

// Без clientId — все тарифы; с clientId — дефолты + переопределения клиента
export function useTariffs(clientId?: string) {
  return useQuery({
    queryKey: qk.tariffs(clientId),
    queryFn: () => api<TariffsRes>('listTariffs', token(), clientId),
    enabled: !!token(),
  });
}

export function useClientItemBilling(clientId: string) {
  return useQuery({
    queryKey: qk.clientItemBilling(clientId),
    queryFn: () => api<ClientItemBillingRes>('listClientItemBilling', token(), clientId),
    enabled: !!token() && !!clientId,
  });
}

export function useClientInvoice(clientId: string, from: string, to: string) {
  return useQuery({
    queryKey: qk.invoice(clientId, from, to),
    queryFn: () => api<InvoiceRes>('getClientInvoice', token(), clientId, from, to),
    enabled: !!token() && !!clientId && !!from && !!to,
  });
}

// --- Зарплаты (P3) ---

// Расчёт по всем сотрудникам прачки (owner); enabled — чтобы не грузить в режимах, где не нужен
export function usePayroll(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: qk.payroll(from, to),
    queryFn: () => api<PayrollRes>('getPayroll', token(), from, to),
    enabled: enabled && !!token() && !!from && !!to,
  });
}

// Переопределения ставок сотрудников (owner)
export function usePayRates() {
  return useQuery({
    queryKey: qk.payRates(),
    queryFn: () => api<PayRatesRes>('listPayRates', token()),
    enabled: !!token(),
  });
}

// Свой авто-отчёт водителя за период
export function useMyPayroll(from: string, to: string) {
  return useQuery({
    queryKey: qk.myPayroll(from, to),
    queryFn: () => api<MyPayrollRes>('getMyPayroll', token(), from, to),
    enabled: !!token() && !!from && !!to,
  });
}

// Дефолтные ставки прачки (P3.1, owner)
export function usePaySettings() {
  return useQuery({
    queryKey: qk.paySettings(),
    queryFn: () => api<PaySettingsRes>('listPaySettings', token()),
    enabled: !!token(),
  });
}

// Корректировки зарплаты (owner); пустые фильтры = все за прачку
export function usePayAdjustments(userId?: string, from?: string, to?: string) {
  return useQuery({
    queryKey: qk.payAdjustments(userId, from, to),
    queryFn: () => api<PayAdjustmentsListRes>('listPayAdjustments', token(), userId || '', from || '', to || ''),
    enabled: !!token(),
  });
}

// --- Мутации ---

// Инвалидирует операционные чтения (стирка/развоз/неделя/склад/отчёт взаимосвязаны).
function useInvalidateOperational() {
  const qc = useQueryClient();
  return () => {
    OPERATIONAL_PREFIXES.forEach((p) => qc.invalidateQueries({ queryKey: [p] }));
  };
}

// Базовая обёртка: мутация с токеном, ошибка → toast с текстом сервера.
// Вызов: mutation.mutate(arg) для одного аргумента или mutation.mutate([a, b, c]) для нескольких —
// TanStack передаёт в mutationFn только одно значение, поэтому массив = список аргументов API.
export function useApiMutation<TRes = any>(
  method: string,
  opts?: { invalidate?: 'operational' | string[]; onSuccess?: (res: TRes) => void }
) {
  const qc = useQueryClient();
  const invalidateOp = useInvalidateOperational();
  const toast = useUiStore((s) => s.toast);
  return useMutation({
    mutationFn: (vars: unknown) =>
      api<TRes>(method, token(), ...(Array.isArray(vars) ? vars : [vars])),
    onSuccess: (res) => {
      if (opts?.invalidate === 'operational') invalidateOp();
      else if (Array.isArray(opts?.invalidate)) {
        opts.invalidate.forEach((p) => qc.invalidateQueries({ queryKey: [p] }));
      }
      opts?.onSuccess?.(res);
    },
    onError: (e: Error) => toast(e.message || 'Ошибка сервера', 'err'),
  });
}

// --- Зарплаты (P3): мутации owner ---

// Upsert переопределения ставок сотрудника: mutate([userId, fields])
export function useSavePayRate(onSuccess?: () => void) {
  return useApiMutation('savePayRate', {
    invalidate: ['payroll', 'payRates', 'myPayroll'],
    onSuccess,
  });
}

// Дефолтные ставки прачки (P3.1): mutate(fields); пустое поле = встроенный дефолт
export function useSavePaySettings(onSuccess?: () => void) {
  return useApiMutation('savePaySettings', {
    invalidate: ['payroll', 'payRates', 'myPayroll', 'paySettings'],
    onSuccess,
  });
}

// Ручная корректировка (премия/штраф): mutate([userId, date, amount, comment])
export function useSavePayAdjustment(onSuccess?: (res: PayAdjustmentRes) => void) {
  return useApiMutation<PayAdjustmentRes>('savePayAdjustment', {
    invalidate: ['payroll', 'myPayroll', 'payAdjustments'],
    onSuccess,
  });
}

// Удаление корректировки: mutate(adjId)
export function useDeletePayAdjustment(onSuccess?: () => void) {
  return useApiMutation('deletePayAdjustment', {
    invalidate: ['payroll', 'myPayroll', 'payAdjustments'],
    onSuccess,
  });
}
