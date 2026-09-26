'use client';

// Клиентский портал (тикет P1). Этап 1: плейсхолдер — вход открыт, разделы
// (заявка на забор, трекинг) появятся на этапах 3–4. Мобильный first:
// вводит горничная с телефона.
import { useRequireRole, useLogout } from '@/hooks/use-session';
import { Button } from '@/components/ui/Button';
import styles from './portal.module.css';

export default function PortalPage() {
  const session = useRequireRole(['client']);
  const logout = useLogout();
  if (!session) return null;
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.title}>Здравствуйте</h1>
        <p className={styles.text}>
          Личный кабинет клиента скоро появится: здесь можно будет оформить заявку на забор белья
          и следить за готовностью.
        </p>
        <Button variant="subtle" onClick={logout}>
          Выйти
        </Button>
      </div>
    </div>
  );
}
