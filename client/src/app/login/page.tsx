'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Droplets } from 'lucide-react';
import { api } from '@/lib/api';
import { saveSession } from '@/lib/session';
import type { LoginRes } from '@/types/api';
import { Button } from '@/components/ui/Button';
import styles from './login.module.css';

// Вход: логин + пароль (PIN-входа на сервере нет — server/auth.js).
export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  async function doLogin() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api<LoginRes>('login', login.trim(), password);
      saveSession(res);
      router.replace(res.role === 'driver' ? '/driver' : res.role === 'worker' ? '/worker' : '/today');
    } catch (e: any) {
      setError(e.message || 'Ошибка входа');
      setBusy(false);
      // Лёгкая тряска карточки при ошибке (спека §5)
      setShake(true);
      setTimeout(() => setShake(false), 400);
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={`${styles.card} ${shake ? styles.shake : ''}`}>
        <div className={styles.logo}>
          <Droplets size={20} color="#fff" />
        </div>
        <h1 className={styles.title}>Вход в CleanLab Pro</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doLogin();
          }}
        >
          <input
            className={styles.input}
            placeholder="Логин"
            autoComplete="username"
            autoFocus
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          <input
            className={styles.input}
            type="password"
            placeholder="Пароль"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" variant="primary" busy={busy} className={styles.submit}>
            Войти
          </Button>
          <div className={styles.err}>{error}</div>
        </form>
      </div>
    </div>
  );
}
