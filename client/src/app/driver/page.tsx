'use client';

// Экран водителя: маршрут дня, история, профиль.
// Порт legacy renderDriver + openDriverVisit (server/public/index.html:1103-1301).
import { useEffect, useMemo, useState } from 'react';
import { Truck, History, User, MapPin, Phone, LogOut } from 'lucide-react';
import type { DriverRouteRes } from '@/types/api';
import { useDriverRoute, useApiMutation } from '@/hooks/use-api';
import { useRequireRole, useLogout } from '@/hooks/use-session';
import { useUiStore } from '@/stores/ui';
import { todayStr, shiftDateStr, formatDateRu, timeOf } from '@/lib/dates';
import { num, bags } from '@/lib/format';
import { roleLabel } from '@/lib/dicts';
import { MobileLayout, MobileSection } from '@/components/layout/MobileLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Empty } from '@/components/ui/Empty';
import { Skeleton } from '@/components/ui/Skeleton';
import styles from './driver.module.css';

type RouteVisit = DriverRouteRes['visits'][number] & { contact?: string };
type DriverAction = 'take_clean' | 'deliver_clean' | 'pickup_dirty' | 'both' | 'empty';

// Действия по состоянию точки — 1:1 из legacy openDriverVisit
function actionsFor(v: RouteVisit): Array<{ act: DriverAction; label: string; primary: boolean }> {
  const rows: Array<{ act: DriverAction; label: string; primary: boolean }> = [];
  const stockBags = num(v.clean_stock_bags);
  if (v.clean_taken_at && !v.delivered_at) {
    // Комбо: чистое у водителя и грязное ещё не забрано — одна кнопка вместо двух
    if (!v.picked_at) rows.push({ act: 'both', label: 'Отдал чистое, забрал грязное', primary: true });
    rows.push({ act: 'deliver_clean', label: 'Доставлено', primary: !v.picked_at ? false : true });
  } else if (v.has_clean) {
    rows.push({ act: 'take_clean', label: 'Взял чистое' + (stockBags ? ` (${bags(stockBags)})` : ''), primary: true });
  }
  if (!v.picked_at) rows.push({ act: 'pickup_dirty', label: 'Забрал грязное', primary: rows.length === 0 });
  if (!v.clean_taken_at && !v.picked_at) rows.push({ act: 'empty', label: 'Ничего нет', primary: false });
  return rows;
}

// Метастрока точки — 1:1 из legacy renderDriver
function visitMeta(v: RouteVisit, done: boolean): string[] {
  const meta: string[] = [];
  if (v.address) meta.push(v.address);
  if (!done) {
    if (v.clean_taken_at && !v.delivered_at) {
      meta.push('🚚 чистое у вас' + (num(v.clean_bags) ? `: ${bags(num(v.clean_bags))}` : ''));
    } else if (v.has_clean) {
      meta.push('✨ чистое на складе: ' + (num(v.clean_stock_bags) ? bags(num(v.clean_stock_bags)) : 'есть'));
    }
    if (v.picked_at) meta.push('🟥 грязное у вас');
    else meta.push('🧺 забрать грязное');
  }
  return meta;
}

function greetingFor(name: string): string {
  const h = new Date().getHours();
  const part = h < 6 ? 'доброй ночи' : h < 12 ? 'доброе утро' : h < 18 ? 'добрый день' : 'добрый вечер';
  return `${name}, ${part}`;
}

export default function DriverPage() {
  const session = useRequireRole(['driver']);
  const logout = useLogout();
  const toast = useUiStore((s) => s.toast);

  const [tab, setTab] = useState<'route' | 'history' | 'profile'>('route');
  // «Маршрут» — всегда сегодня; «История» — выбранная дата (в legacy — навигация ‹ › по дням)
  const [histDate, setHistDate] = useState(todayStr());
  const date = tab === 'history' ? histDate : todayStr();

  const query = useDriverRoute(date);
  useEffect(() => {
    if (query.isError) toast(query.error.message || 'Не удалось загрузить маршрут', 'err');
  }, [query.isError, query.error, toast]);

  const route = query.data;
  const cargo = route?.cargo || { clean_bags: 0, clean_points: 0, dirty_points: 0 };

  // --- Мутации ---
  const actionMut = useApiMutation('driverAction', {
    invalidate: 'operational',
    onSuccess: () => toast('Отмечено ✓'),
  });
  const takeAllMut = useApiMutation<{ taken: number; bags: number }>('driverTakeAllClean', {
    invalidate: 'operational',
    onSuccess: (res) => toast(`Взято: ${res.taken} точек, ${res.bags} меш. ✓`),
  });
  // Выборочный take_clean цепочкой: без промежуточных тостов, один итоговый — как в legacy
  const takeSelMut = useApiMutation('driverAction', { invalidate: 'operational' });
  const handoverMut = useApiMutation<{ handed: number }>('driverHandover', {
    invalidate: 'operational',
    onSuccess: (res) => toast(`Передано на склад: ${res.handed} ✓`),
  });

  // --- Локальное состояние диалогов ---
  const [visitTarget, setVisitTarget] = useState<RouteVisit | null>(null); // модал действий по точке
  const [floor, setFloor] = useState(1); // этаж подъёма в модале (P2); сбрасывается при смене visitTarget
  const [takeConfirm, setTakeConfirm] = useState<null | { visitId: string; floor: number | null }>(null); // «Чистое бельё взято со склада?»
  const [takeAllOpen, setTakeAllOpen] = useState(false);
  const [takeSelOpen, setTakeSelOpen] = useState(false);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [selBusy, setSelBusy] = useState(false);

  const openVisit = (v: RouteVisit) => {
    setVisitTarget(v);
    setFloor(Math.max(1, Math.floor(num(v.lift_floor)) || 1));
  };

  const runAction = (visitId: string, act: DriverAction) => {
    const lift = floor > 2 ? floor : null; // пусто/1/2 — без доплаты (сервер нормализует)
    if (act === 'take_clean') {
      // Как в legacy: подтверждение перед take_clean
      setVisitTarget(null);
      setTakeConfirm({ visitId, floor: lift });
      return;
    }
    setVisitTarget(null);
    actionMut.mutate([visitId, act, lift]);
  };

  // Чистое на складе, которое надо развезти (planned + has_clean + ещё не взято)
  const toTake = useMemo(
    () => (route?.visits || []).filter((v) => v.status === 'planned' && v.has_clean && !v.clean_taken_at),
    [route]
  );
  const totalStockBags = toTake.reduce((s, v) => s + num(v.clean_stock_bags), 0);

  // contact в контракте API не задан, но может прийти от сервера — типизируем локально
  const visits = (route?.visits || []) as RouteVisit[];
  const planned = visits.filter((v) => v.status === 'planned');
  const doneVisits = visits.filter((v) => v.status !== 'planned');
  // const nextVisit = planned[0];
  // const restVisits = planned.slice(1);

  if (!session) return null;

  const nav = [
    { key: 'route', label: 'Маршрут', icon: <Truck size={19} /> },
    { key: 'history', label: 'История', icon: <History size={19} /> },
    { key: 'profile', label: 'Профиль', icon: <User size={19} /> },
  ];

  return (
    <MobileLayout
      contextLine={`Маршрут · ${formatDateRu(date, false)}`}
      greeting={greetingFor(session.name)}
      stats={[
        { value: cargo.clean_bags, label: 'Чистое, меш.', tone: cargo.clean_bags ? 'ok' : 'default' },
        { value: cargo.clean_points, label: 'Точек выдачи' },
        { value: cargo.dirty_points, label: 'Точек забора', tone: cargo.dirty_points ? 'warn' : 'default' },
      ]}
      nav={nav}
      activeNav={tab}
      onNav={(k) => setTab(k as typeof tab)}
    >
      {query.isLoading && (
        <>
          <Skeleton height={14} width="40%" />
          <div className={styles.gap} />
          <Skeleton height={120} radius={12} />
          <div className={styles.gap} />
          <Skeleton height={64} radius={12} />
          <div className={styles.gap} />
          <Skeleton height={64} radius={12} />
        </>
      )}

      {query.isError && !route && (
        <Empty
          title="Не удалось загрузить маршрут"
          hint="Проверьте связь и попробуйте ещё раз"
          action={<Button onClick={() => query.refetch()}>Повторить</Button>}
        />
      )}

      {/* ===== Маршрут ===== */}
      {route && tab === 'route' && (
        <>
          {/* Мой груз: бельё, которое физически у водителя (по всем дням) */}
          {(cargo.clean_points > 0 || cargo.dirty_points > 0) && (
            <MobileSection label="Мой груз">
              <Card>
                <div className={styles.meta}>🟦 Чистое: <b>{bags(cargo.clean_bags)}</b> ({cargo.clean_points} точек)</div>
                <div className={styles.meta}>🟥 Грязное: <b>{cargo.dirty_points} точек</b></div>
                {cargo.dirty_points > 0 && (
                  <Button className={styles.bigBtn} onClick={() => setHandoverOpen(true)}>
                    Передать грязное на склад
                  </Button>
                )}
              </Card>
            </MobileSection>
          )}

          {/* Чистое на складе — развезти */}
          {toTake.length > 0 && (
            <MobileSection label={`Чистое на складе — развезти (${toTake.length} точек${totalStockBags ? `, ${totalStockBags} меш.` : ''})`}>
              <Card>
                {toTake.map((v) => (
                  <label key={v.id} className={styles.takeRow}>
                    <input
                      type="checkbox"
                      className={styles.takeChk}
                      checked={checked[v.id] !== false}
                      onChange={(e) => setChecked({ ...checked, [v.id]: e.target.checked })}
                    />
                    <span className={styles.takeName}>
                      {v.client_name}
                      {v.address && <span className={styles.takeAddr}>{v.address}</span>}
                    </span>
                    <b className={styles.takeBags}>{num(v.clean_stock_bags) ? bags(num(v.clean_stock_bags)) : '—'}</b>
                  </label>
                ))}
                <Button className={styles.bigBtn} onClick={() => setTakeSelOpen(true)}>
                  Забрать выбранные
                </Button>
                {toTake.length >= 2 && (
                  <Button variant="ghost" className={styles.bigBtn} onClick={() => setTakeAllOpen(true)}>
                    Забрать всё ({toTake.length} точек{totalStockBags ? `, ${totalStockBags} меш.` : ''})
                  </Button>
                )}
              </Card>
            </MobileSection>
          )}

          {!route.visits.length && <Empty title="Адресов нет" hint={`На ${formatDateRu(date, false)} развоза нет`} />}


          {planned.length > 0 && (
          <MobileSection label={`Адреса (${planned.length})`}>
            {planned.map((v) => (
              <Card key={v.id} interactive className={styles.compactCard} onClick={() => openVisit(v)}>
                <div className={styles.cardName}>{v.client_name}</div>
                <div className={styles.metaDim}>{visitMeta(v, false).join(' · ')}</div>
              </Card>
            ))}
          </MobileSection>
        )}

          {/* Следующий адрес */}
          {/* {nextVisit && (
            <MobileSection label="Следующий адрес">
              <Card className={styles.nextCard}>
                <div className={styles.nextName}>{nextVisit.client_name}</div>
                {nextVisit.address && (
                  <div className={styles.meta}>
                    <MapPin size={14} className={styles.inlineIcon} /> {nextVisit.address}
                  </div>
                )}
                {(num(nextVisit.clean_bags) > 0 || nextVisit.clean_kg > 0) && (
                  <div className={styles.meta}>
                    {num(nextVisit.clean_bags) > 0 && bags(num(nextVisit.clean_bags))}
                    {num(nextVisit.clean_bags) > 0 && nextVisit.clean_kg > 0 && ' · '}
                    {nextVisit.clean_kg > 0 && `${nextVisit.clean_kg} кг`}
                  </div>
                )}
                {nextVisit.contact && (
                  <a className={styles.phone} href={`tel:${nextVisit.contact}`}>
                    <Phone size={15} /> {nextVisit.contact}
                  </a>
                )}
                <div className={styles.metaDim}>{visitMeta(nextVisit, false).filter((m) => m !== nextVisit.address).join(' · ')}</div>
                {actionsFor(nextVisit).map((a) => (
                  <Button
                    key={a.act}
                    variant={a.primary ? 'primary' : 'ghost'}
                    className={styles.bigBtn}
                    busy={actionMut.isPending}
                    onClick={() => runAction(nextVisit.id, a.act)}
                  >
                    {a.act === 'deliver_clean' || a.act === 'both' ? `🚚 ${a.label}` : a.label}
                  </Button>
                ))}
                {nextVisit.address && (
                  <a
                    className={styles.mapsLink}
                    href={`https://yandex.ru/maps/?text=${encodeURIComponent(nextVisit.address)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Построить маршрут
                  </a>
                )}
              </Card>
            </MobileSection>
          )} */}

          {/* Далее */}
          {/* {restVisits.length > 0 && (
            <MobileSection label="Далее">
              {restVisits.map((v) => (
                <Card key={v.id} interactive className={styles.compactCard} onClick={() => setVisitTarget(v)}>
                  <div className={styles.cardName}>{v.client_name}</div>
                  <div className={styles.metaDim}>{visitMeta(v, false).join(' · ')}</div>
                </Card>
              ))}
            </MobileSection>
          )} */}
        </>
      )}

      {/* ===== История ===== */}
      {route && tab === 'history' && (
        <MobileSection label={`Выполненные · ${formatDateRu(histDate, false)}`}>
          <div className={styles.dateNav}>
            <Button variant="ghost" size="sm" onClick={() => setHistDate(shiftDateStr(histDate, -1))}>‹</Button>
            <span className={styles.dateNavLabel}>{formatDateRu(histDate)}</span>
            <Button variant="ghost" size="sm" onClick={() => setHistDate(shiftDateStr(histDate, 1))}>›</Button>
          </div>
          {histDate !== todayStr() && (
            <div className={styles.todayWrap}>
              <Button variant="subtle" size="sm" onClick={() => setHistDate(todayStr())}>Сегодня</Button>
            </div>
          )}
          {doneVisits.length === 0 && <Empty title="Адресов нет" hint="На эту дату выполненных визитов нет" />}
          {doneVisits.map((v) => (
            <Card key={v.id} className={styles.compactCard}>
              <div className={styles.histRow}>
                <div className={styles.cardName}>{v.client_name}</div>
                <StatusBadge status={v.status} size="sm" />
              </div>
              {v.address && <div className={styles.metaDim}>{v.address}</div>}
              <div className={styles.metaDim}>
                {v.delivered_at && `Выдано ${timeOf(v.delivered_at)}`}
                {v.delivered_at && v.picked_at && ' · '}
                {v.picked_at && `Забрано ${timeOf(v.picked_at)}`}
              </div>
            </Card>
          ))}
        </MobileSection>
      )}

      {/* ===== Профиль ===== */}
      {tab === 'profile' && (
        <MobileSection label="Профиль">
          <Card>
            <div className={styles.profileName}>{session.name}</div>
            <div className={styles.meta}>{roleLabel(session.role)}</div>
            {route?.laundryName && <div className={styles.metaDim}>Прачка: {route.laundryName}</div>}
            <Button variant="ghost" className={styles.bigBtn} icon={<LogOut size={16} />} onClick={logout}>
              Выход
            </Button>
          </Card>
        </MobileSection>
      )}

      {/* ===== Диалоги ===== */}

      {/* Действия по точке (порт openDriverVisit) */}
      <Modal open={!!visitTarget} onClose={() => setVisitTarget(null)} title={visitTarget?.client_name || ''}>
        {visitTarget && (
          <>
            <div className={styles.metaDim}>{visitMeta(visitTarget, false).join(' · ')}</div>
            <div className={styles.floorRow}>
              <span className={styles.floorLabel}>Этаж</span>
              <Button
                variant="subtle"
                size="sm"
                aria-label="Этаж ниже"
                disabled={floor <= 1}
                onClick={() => setFloor((f) => Math.max(1, f - 1))}
              >
                −
              </Button>
              <span className={styles.floorVal}>{floor}</span>
              <Button
                variant="subtle"
                size="sm"
                aria-label="Этаж выше"
                onClick={() => setFloor((f) => f + 1)}
              >
                +
              </Button>
              {floor > 2 && <span className={styles.metaDim}>доплата за подъём</span>}
            </div>
            {actionsFor(visitTarget).map((a) => (
              <Button
                key={a.act}
                variant={a.primary ? 'primary' : 'ghost'}
                className={styles.bigBtn}
                busy={actionMut.isPending}
                onClick={() => runAction(visitTarget.id, a.act)}
              >
                {a.label}
              </Button>
            ))}
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!takeConfirm}
        onClose={() => setTakeConfirm(null)}
        onConfirm={() => {
          if (takeConfirm) actionMut.mutate([takeConfirm.visitId, 'take_clean', takeConfirm.floor]);
          setTakeConfirm(null);
        }}
        text="Чистое бельё взято со склада?"
        okLabel="Да, взял"
        busy={actionMut.isPending}
      />

      <ConfirmDialog
        open={takeAllOpen}
        onClose={() => setTakeAllOpen(false)}
        onConfirm={() => {
          takeAllMut.mutate(date);
          setTakeAllOpen(false);
        }}
        text={`Взять чистое бельё для ${toTake.length} точек?`}
        okLabel="Да, взял"
        busy={takeAllMut.isPending}
      />

      <ConfirmDialog
        open={takeSelOpen}
        onClose={() => setTakeSelOpen(false)}
        onConfirm={async () => {
          const sel = toTake.filter((v) => checked[v.id] !== false);
          if (!sel.length) {
            toast('Выберите точки', 'err');
            setTakeSelOpen(false);
            return;
          }
          const selBags = sel.reduce((s, v) => s + num(v.clean_stock_bags), 0);
          setSelBusy(true);
          try {
            // Цепочка take_clean по каждой отмеченной точке — как в legacy
            for (const v of sel) await takeSelMut.mutateAsync([v.id, 'take_clean']);
            toast(`Взято: ${sel.length} точек, ${selBags} меш. ✓`);
          } catch {
            // ошибка уже показана тостом в useApiMutation
          } finally {
            setSelBusy(false);
            setTakeSelOpen(false);
          }
        }}
        text={(() => {
          const sel = toTake.filter((v) => checked[v.id] !== false);
          const selBags = sel.reduce((s, v) => s + num(v.clean_stock_bags), 0);
          return `Забрать чистое: ${sel.length} точек${selBags ? `, ${selBags} меш.` : ''}?`;
        })()}
        okLabel="Да, взял"
        busy={selBusy}
      />

      <ConfirmDialog
        open={handoverOpen}
        onClose={() => setHandoverOpen(false)}
        onConfirm={() => {
          handoverMut.mutate([]);
          setHandoverOpen(false);
        }}
        text="Передать всё грязное бельё на склад?"
        okLabel="Передать"
        busy={handoverMut.isPending}
      />
    </MobileLayout>
  );
}
