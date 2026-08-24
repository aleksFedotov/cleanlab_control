'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Clock, Waves, Calendar, Package, BarChart3, BookOpen, Users, Building2,
  LogOut, Droplets, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useDeliveryVisits } from '@/hooks/use-api';
import { useLogout } from '@/hooks/use-session';
import { todayStr } from '@/lib/dates';
import styles from './Sidebar.module.css';

const NAV = [
  { href: '/today', label: 'Сегодня', icon: Clock },
  { href: '/wash', label: 'Стирка', icon: Waves },
  { href: '/plan', label: 'План', icon: Calendar },
  { href: '/storage', label: 'Склад', icon: Package },
  { href: '/report', label: 'Отчёт', icon: BarChart3 },
];
const NAV_SETTINGS = [
  { href: '/refs', label: 'Справочники', icon: BookOpen },
  { href: '/users', label: 'Сотрудники', icon: Users },
  { href: '/laundries', label: 'Прачки', icon: Building2 },
];

export function Sidebar() {
  const pathname = usePathname();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const mobileOpen = useUiStore((s) => s.sidebarOpenMobile);
  const setMobileOpen = useUiStore((s) => s.setSidebarOpenMobile);
  const logout = useLogout();

  // Бейдж-счётчик визитов на сегодня у пункта «Сегодня»
  const visits = useDeliveryVisits(todayStr());
  const todayCount = (visits.data?.visits || []).filter((v) => v.status !== 'cancelled').length;

  function item({ href, label, icon: Icon }: (typeof NAV)[number]) {
    const active = pathname === href || pathname.startsWith(href + '/');
    return (
      <Link
        key={href}
        href={href}
        title={collapsed ? label : undefined}
        className={`${styles.item} ${active ? styles.active : ''}`}
        onClick={() => setMobileOpen(false)}
      >
        <Icon size={17} />
        {!collapsed && <span className={styles.itemLabel}>{label}</span>}
        {!collapsed && href === '/today' && todayCount > 0 && (
          <span className={styles.badge}>{todayCount}</span>
        )}
      </Link>
    );
  }

  return (
    <>
      {mobileOpen && <div className={styles.overlay} onClick={() => setMobileOpen(false)} />}
      <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''} ${mobileOpen ? styles.mobileOpen : ''}`}>
        <div className={styles.logoRow}>
          <div className={styles.logoIcon}>
            <Droplets size={18} color="#fff" />
          </div>
          {!collapsed && (
            <div>
              <div className={styles.logoName}>CleanLab Pro</div>
              <div className={styles.logoSub}>панель владельца</div>
            </div>
          )}
        </div>
        <nav className={styles.nav}>
          {NAV.map(item)}
          <div className={styles.divider} />
          {NAV_SETTINGS.map(item)}
        </nav>
        <div className={styles.bottom}>
          <button className={styles.collapseBtn} onClick={toggle} title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}>
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            {!collapsed && <span>Свернуть</span>}
          </button>
          <button className={styles.logout} onClick={logout} title="Выход">
            <LogOut size={17} />
            {!collapsed && <span>Выход</span>}
          </button>
        </div>
      </aside>
    </>
  );
}
