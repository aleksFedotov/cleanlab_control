'use client';

// Список заявок клиента (портал, тикет P1): дата, статус, мешки, позиции.
// Клик по заявке открывает форму на эту дату (правка до забора / просмотр после).
import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { useClientRequests, usePortalData } from '@/hooks/use-api';
import { formatDateRu, weekdayOf } from '@/lib/dates';
import { Button } from '@/components/ui/Button';
import type { PortalRequest } from '@/types/api';
import styles from './portal.module.css';

const STATUS_LABEL: Record<PortalRequest['status'], string> = {
  sent: 'Принята',
  picked: 'Забрана',
};

export function RequestsList({
  onNew,
  onOpen,
}: {
  onNew: () => void;
  onOpen: (date: string) => void;
}) {
  const requestsQuery = useClientRequests();
  const portal = usePortalData();
  const requests = requestsQuery.data?.requests || [];
  const typeName = useMemo(() => {
    const m: Record<string, string> = {};
    (portal.data?.itemTypes || []).forEach((t) => {
      m[t.id] = t.name;
    });
    return m;
  }, [portal.data]);

  return (
    <div>
      <Button icon={<Plus size={16} />} onClick={onNew} className={styles.newBtn}>
        Новая заявка
      </Button>
      {requestsQuery.isLoading && <div className={styles.hint}>Загрузка…</div>}
      {!requestsQuery.isLoading && requests.length === 0 && (
        <div className={styles.empty}>
          Заявок пока нет. Оформите заявку на забор — водитель приедет в удобный день.
        </div>
      )}
      {requests.map((r) => {
        const itemsQty = r.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
        return (
          <button
            key={r.id}
            type="button"
            className={styles.reqCard}
            onClick={() => onOpen(r.desired_date)}
          >
            <div className={styles.reqHead}>
              <span className={styles.reqDate}>
                {weekdayOf(r.desired_date)}, {formatDateRu(r.desired_date, false)}
              </span>
              <span className={`${styles.reqStatus} ${r.status === 'picked' ? styles.picked : ''}`}>
                {STATUS_LABEL[r.status]}
              </span>
            </div>
            <div className={styles.reqMeta}>
              {Number(r.bags) > 0 && <span>{Number(r.bags)} меш.</span>}
              {itemsQty > 0 && <span>{itemsQty} вещей</span>}
              {r.items.length > 0 && (
                <span className={styles.reqItems}>
                  {r.items.map((it) => `${typeName[it.item_type_id] || it.item_type_id} ×${Number(it.qty)}`).join(', ')}
                </span>
              )}
              {r.comment && <span className={styles.reqComment}>{r.comment}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
