'use client';

// Форма заявки на забор белья (портал, тикет P1). Мобильный first: крупные
// кнопки, степперы −/+, ручной ввод числа. Одна форма на создание и правку:
// заявка в статусе 'sent' на выбранную дату перезаписывается сервером (upsert
// по client_id + desired_date); после 'picked' — read-only.
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Stepper } from '@/components/Stepper';
import { useApiMutation, useClientRequests, usePortalData } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import { todayStr } from '@/lib/dates';
import { parseItemTypes } from '@/app/(dashboard)/refs/refs-utils';
import { TrackView } from './track-view';
import type { CreateRequestRes, ItemType, PortalDataRes, PortalRequest } from '@/types/api';
import styles from './portal.module.css';

const STEPS = [{ delta: -1, label: '−' }, { delta: 1, label: '+' }];

// Значения полей из заявки на дату (или нули — новая заявка)
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

  // Дата: из списка (правка) → ближайший визит (предвыбор) → сегодня
  const firstVisit = (data.visits || [])[0];
  const [date, setDate] = useState(initialDate || (firstVisit ? firstVisit.date : todayStr()));

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

  // Прошедшие даты — только просмотр (и даты без заявки тоже); забранные
  // заявки ('picked') не редактируются на любой дате
  const past = date < todayStr();
  const readOnly = past || (!!existing && existing.status === 'picked');
  const visitHint = (data.visits || []).find((v) => v.date === date);

  // Смена даты — подставляем состав заявки на эту дату (правка) или чистим
  function changeDate(next: string) {
    const target = requests.find((r) => r.desired_date === next) || null;
    setDate(next);
    setBags(fieldsOf(target).bags);
    setComment(fieldsOf(target).comment);
    setCounts(fieldsOf(target).counts);
  }

  const saveMut = useApiMutation<CreateRequestRes>('clientCreateRequest', {
    onSuccess: () => {
      toast(existing ? 'Заявка обновлена' : 'Заявка отправлена');
      onDone();
    },
  });

  function submit() {
    if (!date) {
      toast('Укажите дату забора', 'err');
      return;
    }
    // Прошлые даты — только просмотр существующих заявок: новую «задним числом»
    // не создаём и sent-заявку на прошедшую дату не переписываем
    if (date < todayStr()) {
      toast('На прошедшую дату заявку отправить нельзя', 'err');
      return;
    }
    const items = itemTypes
      .map((t) => ({ item_type_id: t.id, qty: counts[t.id] || 0 }))
      .filter((it) => it.qty > 0);
    saveMut.mutate([date, bags, comment, items]);
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
          {existing && existing.status === 'picked'
            ? 'Забрано водителем — правка недоступна'
            : 'Прошедшая дата — только просмотр'}
        </div>
      )}

      <label className={styles.field}>
        <span className={styles.label}>Дата забора</span>
        <input
          type="date"
          className={styles.dateInput}
          value={date}
          onChange={(e) => changeDate(e.target.value)}
          data-testid="pickup-date"
        />
        {visitHint && <span className={styles.hint}>В этот день запланирован забор белья</span>}
      </label>

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
          Заявка на эту дату уже есть — отправка перезапишет её состав
        </span>
      )}

      {existing && (
        <TrackView
          request={existing}
          typeNames={Object.fromEntries(itemTypes.map((t) => [t.id, t.name]))}
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
