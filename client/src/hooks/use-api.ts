'use client';

// TanStack Query обёртки над lib/api.ts. Серверное состояние — только через эти хуки.
// Все чтения подставляют токен из сессии; компоненты токен не трогают.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSession } from '@/lib/session';
import { qk, OPERATIONAL_PREFIXES } from '@/lib/query-keys';
import { useUiStore } from '@/stores/ui';
import type {
  DayListRes, DeliveryVisitsRes, WeekPlanRes, StorageRes, DayReportRes, SummaryReportRes,
  RefsRes, UsersRes, LaundriesRes, DriverRouteRes, ShiftCloseStateRes,
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

export function useSummaryReport(from: string, to: string) {
  return useQuery({
    queryKey: qk.summaryReport(from, to),
    queryFn: () => api<SummaryReportRes>('getSummaryReport', token(), from, to),
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
