'use client';

// Добавить вид белья на экран стирки (legacy openAddItemType,
// server/public/index.html:854-915): поиск по справочнику, «Другое…» создаёт
// новый тип, при настроенном списке клиента — «запомнить для клиента».
import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useApiMutation } from '@/hooks/use-api';
import { useUiStore } from '@/stores/ui';
import type { DayWash, ItemType } from '@/types/api';
import styles from './wash-id.module.css';

export interface AddItemTypeModalProps {
  w: DayWash;
  types: ItemType[];
  counts: Record<string, number>;
  extra: string[];
  onPick: (typeId: string, remember: boolean) => void;
  onCreated: (t: ItemType) => void;
  onClose: () => void;
}

export function AddItemTypeModal({
  w,
  types,
  counts,
  extra,
  onPick,
  onCreated,
  onClose,
}: AddItemTypeModalProps) {
  const toast = useUiStore((s) => s.toast);
  const [search, setSearch] = useState('');
  const [otherName, setOtherName] = useState('');
  const [remember, setRemember] = useState(true);

  const saveMutation = useApiMutation<{ ok: true; itemType: ItemType }>('saveItemType');

  // Уже показанные на экране типы: список клиента (или все) + extra + ненулевой пересчёт
  const hiddenTypes = useMemo(() => {
    const shown: Record<string, boolean> = {};
    (w.client_item_types && w.client_item_types.length
      ? w.client_item_types
      : types.map((t) => t.id)
    )
      .concat(extra)
      .forEach((tid) => {
        shown[tid] = true;
      });
    Object.keys(counts).forEach((tid) => {
      if (counts[tid] > 0) shown[tid] = true;
    });
    return types.filter((t) => !shown[t.id]);
  }, [w, types, counts, extra]);

  const q = search.trim().toLowerCase();
  const visible = q ? hiddenTypes.filter((t) => t.name.toLowerCase().includes(q)) : hiddenTypes;
  const canRemember = !!(w.client_item_types && w.client_item_types.length);
  const showOther = !q || 'другое'.includes(q);

  function pick(tid: string) {
    onPick(tid, canRemember && remember);
    onClose();
  }

  function createOther() {
    const name = otherName.trim();
    if (!name) {
      toast('Укажите название', 'err');
      return;
    }
    saveMutation.mutate(
      { name },
      {
        onSuccess: (res) => {
          onCreated(res.itemType);
          pick(res.itemType.id);
        },
      }
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Добавить вид белья"
      footer={
        <Button variant="subtle" onClick={onClose}>
          Назад
        </Button>
      }
    >
      <div className={styles.form}>
        <input
          placeholder="Поиск…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className={styles.typeList}>
          {visible.map((t) => (
            <div key={t.id} className={styles.itemRow}>
              <span className={styles.itemName}>{t.name}</span>
              <Button variant="ghost" size="sm" onClick={() => pick(t.id)}>
                Добавить
              </Button>
            </div>
          ))}
          {showOther && (
            <div className={styles.itemRow}>
              <span className={styles.itemName}>
                <input
                  type="text"
                  placeholder="Другое: название…"
                  value={otherName}
                  onChange={(e) => setOtherName(e.target.value)}
                />
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={createOther}
                busy={saveMutation.isPending}
              >
                Создать
              </Button>
            </div>
          )}
          {!visible.length && !showOther && (
            <div className={styles.meta}>Ничего не найдено</div>
          )}
        </div>
        {canRemember && (
          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Запомнить для этого клиента
          </label>
        )}
      </div>
    </Modal>
  );
}
