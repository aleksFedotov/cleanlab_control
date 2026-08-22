'use client';

// Окно «Добавить в развоз» — порт legacy openDeliveryAdd (index.html:1653-1704):
// поиск по названию/адресу, видимый список, множественный выбор без закрытия,
// мгновенная блокировка повторного тапа + откат при ошибке.
import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Client, DecoratedVisit } from '@/types/api';
import { formatDateRu } from '@/lib/dates';
import { useUiStore } from '@/stores/ui';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import styles from './today.module.css';

export interface AddVisitModalProps {
  open: boolean;
  onClose: () => void;
  date: string;
  clients: Client[];
  visits: DecoratedVisit[];
}

export function AddVisitModal({ open, onClose, date, clients, visits }: AddVisitModalProps) {
  const toast = useUiStore((s) => s.toast);
  const [q, setQ] = useState('');
  const [addedNow, setAddedNow] = useState<Set<string>>(new Set());

  // Сброс при открытии окна — корректировка состояния при рендере (без эффекта)
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQ('');
      setAddedNow(new Set());
    }
  }

  const addMut = useApiMutation('addDeliveryVisit', { invalidate: 'operational' });

  // Кто уже в развозе: из данных + добавленные в этой сессии окна
  const inDelivery = useMemo(() => {
    const s = new Set(visits.map((v) => v.client_id));
    addedNow.forEach((id) => s.add(id));
    return s;
  }, [visits, addedNow]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = clients.filter((c) => {
      if (!needle) return true;
      return (
        c.name.toLowerCase().includes(needle) ||
        (c.address || '').toLowerCase().includes(needle)
      );
    });
    // Сначала доступные (ещё не в развозе), затем уже добавленные
    return filtered.sort((a, b) => {
      const ta = inDelivery.has(a.id) ? 1 : 0;
      const tb = inDelivery.has(b.id) ? 1 : 0;
      return ta - tb || a.name.localeCompare(b.name, 'ru');
    });
  }, [clients, q, inDelivery]);

  function pick(cid: string) {
    if (inDelivery.has(cid)) return;
    setAddedNow((prev) => new Set(prev).add(cid)); // блокируем повторный тап сразу
    addMut.mutate([cid, date], {
      onSuccess: () => toast('Добавлено ✓'),
      onError: () =>
        setAddedNow((prev) => {
          const next = new Set(prev);
          next.delete(cid);
          return next;
        }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Добавить в развоз"
      footer={
        <Button variant="primary" onClick={onClose}>
          Готово
        </Button>
      }
    >
      <div className={styles.modalDate}>{formatDateRu(date)}</div>
      <input
        className={styles.search}
        placeholder="Поиск по названию или адресу…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      <div className={styles.pickList}>
        {list.length === 0 && <div className={styles.pickEmpty}>Никого не найдено</div>}
        {list.map((c) => {
          const taken = inDelivery.has(c.id);
          return (
            <div
              key={c.id}
              className={`${styles.pickRow} ${taken ? styles.pickRowTaken : ''}`}
              onClick={() => !taken && pick(c.id)}
            >
              <div className={styles.pickMain}>
                <div className={styles.pickName}>{c.name}</div>
                <div className={styles.pickMeta}>
                  {c.type || ''}
                  {c.type && c.address ? ' · ' : ''}
                  {c.address || ''}
                </div>
              </div>
              {taken ? (
                <span className={styles.pickTaken}>
                  {addedNow.has(c.id) ? '✓ добавлен' : 'уже в развозе'}
                </span>
              ) : (
                <span className={styles.pickAdd} title="Добавить">
                  <Plus size={16} />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
