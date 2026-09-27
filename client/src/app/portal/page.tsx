'use client';

// Клиентский портал (тикет P1). Мобильный first: вводит горничная с телефона.
// Вкладки: заявка на забор (создание/правка), мои заявки, профиль.
import { useState } from 'react';
import { ClipboardList, ListChecks, User, LogOut } from 'lucide-react';
import { useRequireRole, useLogout } from '@/hooks/use-session';
import { usePortalData } from '@/hooks/use-api';
import { MobileLayout, MobileSection } from '@/components/layout/MobileLayout';
import { Button } from '@/components/ui/Button';
import { RequestForm } from './request-form';
import { RequestsList } from './requests-list';
import styles from './portal.module.css';

type Tab = 'form' | 'list' | 'profile';

function greetingFor(name: string): string {
  const h = new Date().getHours();
  const part = h < 6 ? 'доброй ночи' : h < 12 ? 'доброе утро' : h < 18 ? 'добрый день' : 'добрый вечер';
  return `${name}, ${part}`;
}

export default function PortalPage() {
  const session = useRequireRole(['client']);
  const logout = useLogout();
  const portal = usePortalData();
  const [tab, setTab] = useState<Tab>('form');
  // Дата для открытия формы из списка (правка существующей заявки)
  const [formDate, setFormDate] = useState<string | undefined>(undefined);

  if (!session) return null;

  const clientName = portal.data?.client.name || session.name;
  const nav = [
    { key: 'form', label: 'Заявка', icon: <ClipboardList size={19} /> },
    { key: 'list', label: 'Мои заявки', icon: <ListChecks size={19} /> },
    { key: 'profile', label: 'Профиль', icon: <User size={19} /> },
  ];

  return (
    <MobileLayout
      contextLine="Личный кабинет клиента"
      greeting={greetingFor(clientName)}
      nav={nav}
      activeNav={tab}
      onNav={(k) => setTab(k as Tab)}
    >
      {tab === 'form' && (
        <MobileSection label="Заявка на забор белья">
          <RequestForm
            key={formDate || 'new'}
            initialDate={formDate}
            onDone={() => {
              setFormDate(undefined);
              setTab('list');
            }}
          />
        </MobileSection>
      )}
      {tab === 'list' && (
        <MobileSection label="Мои заявки">
          <RequestsList
            onNew={() => {
              setFormDate(undefined);
              setTab('form');
            }}
            onOpen={(date) => {
              setFormDate(date);
              setTab('form');
            }}
          />
        </MobileSection>
      )}
      {tab === 'profile' && (
        <MobileSection label="Профиль">
          <div className={styles.profileCard}>
            <div className={styles.profileName}>{clientName}</div>
            <Button variant="subtle" icon={<LogOut size={16} />} onClick={logout}>
              Выйти
            </Button>
          </div>
        </MobileSection>
      )}
    </MobileLayout>
  );
}
