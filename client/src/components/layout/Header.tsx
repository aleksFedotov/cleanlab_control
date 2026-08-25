'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Menu, ChevronDown, LogOut } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useLaundries } from '@/hooks/use-api';
import { useLogout, useSession } from '@/hooks/use-session';
import { useSectionDate } from '@/hooks/use-section-date';
import { setLaundryId } from '@/lib/session';
import { api } from '@/lib/api';
import { DateNav } from '@/components/ui/DateNav';
import styles from './Header.module.css';

const TITLES: Record<string, string> = {
  '/today': 'Сегодня',
  '/delivery': 'Развоз',
  '/wash': 'Стирка',
  '/plan': 'План',
  '/storage': 'Склад',
  '/report': 'Отчёт',
  '/summary': 'Сводный отчёт',
  '/refs': 'Справочники',
  '/users': 'Сотрудники',
  '/laundries': 'Прачки',
};

// Раздел → ключ даты в сторе; DateNav показываем только на страницах с датой
// (у главной «Сегодня» даты нет — она всегда про текущий день)
const DATE_SECTIONS: Record<string, 'day' | 'week'> = {
  '/delivery': 'day',
  '/wash': 'day',
  '/plan': 'week',
  '/report': 'day',
};

export function Header() {
  const pathname = usePathname();
  const session = useSession();
  const setMobileOpen = useUiStore((s) => s.setSidebarOpenMobile);
  const logout = useLogout();
  const qc = useQueryClient();
  const laundries = useLaundries();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const basePath = '/' + (pathname.split('/')[1] || '');
  const title = TITLES[basePath] || '';
  const dateMode = DATE_SECTIONS[basePath];
  const [date, setDate] = useSectionDate(basePath.slice(1));

  // Закрытие дропдауна по клику вне
  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  async function onSwitchLaundry(id: string) {
    try {
      await api('switchLaundry', session?.token, id);
      setLaundryId(id);
      qc.invalidateQueries(); // все данные привязаны к прачке
    } catch (e: any) {
      useUiStore.getState().toast(e.message || 'Ошибка переключения прачки', 'err');
    }
  }

  const list = laundries.data?.laundries || [];
  const initial = (session?.name || '?').slice(0, 1).toUpperCase();

  return (
    <header className={styles.header}>
      <button className={styles.burger} onClick={() => setMobileOpen(true)} aria-label="Меню">
        <Menu size={20} />
      </button>
      <h1 className={styles.title}>{title}</h1>
      {dateMode && (
        <div className={styles.dateNav}>
          <DateNav date={date} onChange={setDate} weekMode={dateMode === 'week'} />
        </div>
      )}
      <div className={styles.spacer} />
      {list.length > 1 && (
        <select
          className={styles.laundrySwitch}
          value={session?.laundryId || ''}
          onChange={(e) => onSwitchLaundry(e.target.value)}
          title="Прачка"
        >
          {list.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
      <div className={styles.userWrap} ref={menuRef}>
        <button className={styles.avatar} onClick={() => setMenuOpen(!menuOpen)} aria-label="Профиль">
          {initial}
          <ChevronDown size={14} className={styles.avatarChevron} />
        </button>
        {menuOpen && (
          <div className={styles.dropdown}>
            <div className={styles.dropName}>{session?.name}</div>
            <button className={styles.dropItem} onClick={logout}>
              <LogOut size={15} /> Выход
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
