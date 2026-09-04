'use client';

// Экран водителя: маршрут дня, история, профиль.
// Порт legacy renderDriver + openDriverVisit (server/public/index.html:1103-1301).
import { useEffect, useMemo, useState } from 'react';
import { Truck, History, User, MapPin, Phone, LogOut, KeyRound } from 'lucide-react';
import type { DriverRouteRes } from '@/types/api';
import { useDriverRoute, useApiMutation } from '@/hooks/use-api';
import { useRequireRole, useLogout } from '@/hooks/use-session';
import { useUiStore } from '@/stores/ui';
import { todayStr, formatDateRu, timeOf } from '@/lib/dates';
import { num, bags, money } from '@/lib/format';
import { roleLabel } from '@/lib/dicts';
import { MobileLayout, MobileSection } from '@/components/layout/MobileLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { VisitEditModal } from '@/components/VisitEditModal';
import { Empty } from '@/components/ui/Empty';
import { Skeleton } from '@/components/ui/Skeleton';
import { DateNav } from '@/components/ui/DateNav';
import styles from './driver.module.css';

type RouteVisit = DriverRouteRes['visits'][number];

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
  // Выбранная дата — общая для «Маршрута» и «Истории», листается через DateNav
  const [date, setDate] = useState(todayStr());

  const query = useDriverRoute(date);
  useEffect(() => {
    if (query.isError) toast(query.error.message || 'Не удалось загрузить маршрут', 'err');
  }, [query.isError, query.error, toast]);

  const route = query.data;
  const cargo = route?.cargo || { clean_bags: 0, clean_points: 0, dirty_points: 0 };
  const dayStats = route?.stats || { visited: 0, lift_qty: 0, lift_total: 0, lift_missing: false, lift_pay: 0 };

  // --- Мутации ---
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
  // Модал точки (P6): храним id, сам визит достаём из query-данных — после отмены
  // действия (correctVisit) модал сам перерисуется в режим кнопок
  const [visitId, setVisitId] = useState<string | null>(null);
  const [takeAllOpen, setTakeAllOpen] = useState(false);
  const [takeSelOpen, setTakeSelOpen] = useState(false);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [selBusy, setSelBusy] = useState(false);

  // Чистое на складе, которое надо развезти (planned + has_clean + ещё не взято)
  const toTake = useMemo(
    () => (route?.visits || []).filter((v) => v.status === 'planned' && v.has_clean && !v.clean_taken_at),
    [route]
  );
  const totalStockBags = toTake.reduce((s, v) => s + num(v.clean_stock_bags), 0);

  const visits = route?.visits || [];
  const planned = visits.filter((v) => v.status === 'planned');
  const doneVisits = visits.filter((v) => v.status !== 'planned');
  const visitTarget = visits.find((v) => v.id === visitId) || null;
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
        { value: `${dayStats.visited}/${visits.length}`, label: 'Точек посещено', tone: dayStats.visited && dayStats.visited === visits.length ? 'ok' : 'default' },
        { value: cargo.clean_bags, label: 'Чистое, меш.', tone: cargo.clean_bags ? 'ok' : 'default' },
        { value: cargo.clean_points, label: 'Точек выдачи' },
        { value: cargo.dirty_points, label: 'Точек забора', tone: cargo.dirty_points ? 'warn' : 'default' },
        // Надбавка водителя за подъём выше 2-го этажа: этажи × его зарплатная ставка
        ...(dayStats.lift_qty > 0
          ? [{
              value: `${money(dayStats.lift_pay)} ₽`,
              label: 'Подъём',
              tone: 'ok' as const,
            }]
          : []),
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
          <DateNav date={date} onChange={setDate} />
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
              <Card key={v.id} interactive className={styles.compactCard} onClick={() => setVisitId(v.id)}>
                <div className={styles.cardName}>
                  {v.client_name}
                  {v.access_note && <KeyRound size={14} className={styles.inlineIcon} />}
                </div>
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
        <MobileSection label={`Выполненные · ${formatDateRu(date, false)}`}>
          <DateNav date={date} onChange={setDate} />
          {doneVisits.length === 0 && <Empty title="Адресов нет" hint="На эту дату выполненных визитов нет" />}
          {doneVisits.map((v) => (
            <Card key={v.id} interactive className={styles.compactCard} onClick={() => setVisitId(v.id)}>
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

      {/* Действия/правка по точке (P6): общий модал — маршрут, история, «Развоз» владельца */}
      <VisitEditModal visit={visitTarget} onClose={() => setVisitId(null)} />

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
