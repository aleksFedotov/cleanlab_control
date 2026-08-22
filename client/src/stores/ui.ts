'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ToastItem {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

interface UiState {
  // persist-часть
  sidebarCollapsed: boolean;
  washViewMode: 'board' | 'list';
  toggleSidebar: () => void;
  setWashViewMode: (m: 'board' | 'list') => void;
  // не-persist
  sidebarOpenMobile: boolean;
  setSidebarOpenMobile: (v: boolean) => void;
  offline: boolean;
  setOffline: (v: boolean) => void;
  toasts: ToastItem[];
  toast: (text: string, kind?: 'ok' | 'err') => void;
  dismissToast: (id: number) => void;
  // Выбранная дата по разделам ('today' | 'wash' | 'plan' | 'report') — для DateNav в хедере
  dates: Record<string, string | undefined>;
  setDate: (section: string, date: string) => void;
}

let toastSeq = 1;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      washViewMode: 'board',
      toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
      setWashViewMode: (m) => set({ washViewMode: m }),

      sidebarOpenMobile: false,
      setSidebarOpenMobile: (v) => set({ sidebarOpenMobile: v }),

      offline: false,
      setOffline: (v) => set({ offline: v }),

      toasts: [],
      toast: (text, kind = 'ok') => {
        const id = toastSeq++;
        // Стек до 3 шт (спека §3 Toast)
        const toasts = [...get().toasts, { id, text, kind }].slice(-3);
        set({ toasts });
        setTimeout(() => get().dismissToast(id), 4000);
      },
      dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

      dates: {},
      setDate: (section, date) => set({ dates: { ...get().dates, [section]: date } }),
    }),
    {
      name: 'cl_ui',
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed, washViewMode: s.washViewMode }),
    }
  )
);
