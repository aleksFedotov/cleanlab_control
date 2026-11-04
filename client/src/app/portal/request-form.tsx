'use client';

// Форма заявки на сдачу белья (портал, тикет P1). Мобильный first: крупные
// кнопки, степперы −/+, ручной ввод числа. Дату клиент не выбирает: заявка
// всегда «на сегодня» — день, когда бельё сняли. Одна форма на создание и
// правку: заявка в статусе 'sent' за сегодня перезаписывается сервером
// (upsert по client_id + desired_date); после 'picked' — read-only.
// Из списка прошлых заявок открывается read-only просмотр (initialDate).
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Stepper } from '@/components/Stepper';
import { useApiMutation, useClientRequests, usePortalData } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { formatDateRu, todayStr } from '@/lib/dates';
import { parseItemTypes } from '@/app/(dashboard)/refs/refs-utils';
import { TrackView } from './track-view';
import type { CreateRequestRes, ItemType, PortalDataRes, PortalRequest } from '@/types/api';
import styles from './portal.module.css';

const STEPS = [{ delta: -1, label: '−' }, { delta: 1, label: '+' }];

// Значения полей из заявки (или нули — новая заявка)
function fieldsOf(existing: PortalRequest | null) {
  if (!existing) return { bags: 0, comment: '', counts: {} as Record<string, number> };
  const counts: Record<string, number> = {};
  existing.items.forEach((it) => {
    counts[it.item_type_id] = Number(it.qty) || 0;
  });
  return { bags: Number(existing.bags) || 0, comment: existing.comment || '', counts };
}

function RequestFormInner({
  data,
  requests,
  initialDate,
  onDone,
}: {
  data: PortalDataRes;
  requests: PortalRequest[];
  initialDate?: string;
  onDone: () => void;
}) {
  const offline = useUiStore((s) => s.offline);
  const toast = useUiStore((s) => s.toast);

  const today = todayStr();
  // Просмотр прошлой заявки из списка — только чтение; иначе работаем с сегодня
  const viewing = !!initialDate && initialDate !== today;
  const date = viewing ? initialDate! : today;

  const existing = useMemo(
    () => requests.find((r) => r.desired_date === date) || null,
    [requests, date]
  );
  const [bags, setBags] = useState(() => fieldsOf(existing).bags);
  const [comment, setComment] = useState(() => fieldsOf(existing).comment);
  const [counts, setCounts] = useState<Record<string, number>>(() => fieldsOf(existing).counts);

  // Виды белья клиента: ограниченный список из карточки или все активные
  const itemTypes: ItemType[] = useMemo(() => {
    const all = data.itemTypes || [];
    const own = parseItemTypes(data.client.item_types);
    return own.length ? all.filter((t) => own.indexOf(t.id) !== -1) : all;
  }, [data]);

  // Забранные заявки ('picked') не редактируются; прошлые даты — только просмотр
  const readOnly = viewing || (!!existing && existing.status === 'picked');
  const visitToday = (data.visits || []).find((v) => v.date === today);

  const saveMut = useApiMutation<CreateRequestRes>('clientCreateRequest', {
    onSuccess: () => {
      toast(existing ? 'Заявка обновлена' : 'Заявка отправлена');
      onDone();
    },
  });

  function submit() {
    const items = itemTypes
      .map((t) => ({ item_type_id: t.id, qty: counts[t.id] || 0 }))
      .filter((it) => it.qty > 0);
    saveMut.mutate([bags, comment, items]);
  }

  return (
    <div className={styles.form}>
      {offline && (
        <div className={styles.offlineBox} role="alert">
          Нет связи — данные НЕ сохранены
        </div>
      )}
      {readOnly && (
        <div className={styles.roBox}>
          {viewing
            ? `Заявка за ${formatDateRu(date)} — только просмотр`
            : 'Забрано водителем — правка недоступна'}
        </div>
      )}

      <div className={styles.field}>
        <span className={styles.label}>Дата сдачи</span>
        <span className={styles.roValue} data-testid="pickup-date">
          {viewing ? formatDateRu(date) : `Сегодня, ${formatDateRu(today, false)}`}
        </span>
        {!viewing && visitToday && (
          <span className={styles.hint}>Сегодня запланирован забор белья</span>
        )}
        {!viewing && !visitToday && (
          <span className={styles.hint}>
            Водитель заберёт бельё в ближайший визит
          </span>
        )}
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Бельё по видам</span>
        {itemTypes.length === 0 && <span className={styles.hint}>Виды белья не настроены</span>}
        {itemTypes.map((t) => (
          <div key={t.id} className={styles.itemRow} data-item-type={t.name}>
            <span className={styles.itemName}>{t.name}</span>
            {readOnly ? (
              <span className={styles.roValue}>{counts[t.id] || 0}</span>
            ) : (
              <Stepper
                value={counts[t.id] || 0}
                steps={STEPS}
                onStep={(d) =>
                  setCounts((m) => ({ ...m, [t.id]: Math.max(0, (m[t.id] || 0) + d) }))
                }
                onValueChange={(v) => setCounts((m) => ({ ...m, [t.id]: v }))}
              />
            )}
          </div>
        ))}
      </div>

      <div className={styles.field} data-testid="bags-field">
        <span className={styles.label}>Мешки</span>
        {readOnly ? (
          <span className={styles.roValue}>{bags}</span>
        ) : (
          <Stepper
            value={bags}
            steps={STEPS}
            onStep={(d) => setBags((b) => Math.max(0, b + d))}
            onValueChange={setBags}
          />
        )}
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Комментарий</span>
        <textarea
          className={styles.comment}
          rows={3}
          placeholder="Например: забрать до 12:00, пропуск у консьержа"
          value={comment}
          disabled={readOnly}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>

      {!readOnly && (
        <Button busy={saveMut.isPending} onClick={submit} className={styles.submit}>
          {existing ? 'Сохранить изменения' : 'Отправить заявку'}
        </Button>
      )}
      {existing && !readOnly && (
        <span className={styles.hint}>
          Заявка за сегодня уже есть — отправка перезапишет её состав
        </span>
      )}

      {existing && (
        <TrackView
          request={existing}
          // Имена — по всем активным видам, не по ограниченному списку клиента:
          // в заявке могут быть позиции вне его текущего набора (состав менялся)
          typeNames={Object.fromEntries((data.itemTypes || []).map((t) => [t.id, t.name]))}
        />
      )}
    </div>
  );
}

export function RequestForm({ initialDate, onDone }: { initialDate?: string; onDone: () => void }) {
  const portal = usePortalData();
  const requestsQuery = useClientRequests();

  if (portal.isLoading || requestsQuery.isLoading) {
    return <div className={styles.hint}>Загрузка…</div>;
  }
  if (portal.isError || !portal.data || requestsQuery.isError || !requestsQuery.data) {
    return <div className={styles.hint}>Не удалось загрузить данные. Попробуйте ещё раз.</div>;
  }
  return (
    <RequestFormInner
      key={initialDate || 'new'}
      data={portal.data}
      requests={requestsQuery.data.requests}
      initialDate={initialDate}
      onDone={onDone}
    />
  );
}
