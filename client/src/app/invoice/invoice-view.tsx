'use client';

// Документ счёта: шапка с реквизитами клиента, период, таблица строк, итого.
// Печать — window.print(); кнопки скрыты при печати (.no-print в globals.css).
import { useSearchParams } from 'next/navigation';
import { Printer, TriangleAlert } from 'lucide-react';
import { useClientInvoice } from '@/hooks/use-api';
import { useRequireRole } from '@/hooks/use-session';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty } from '@/components/ui/Empty';
import { formatDateRu } from '@/lib/dates';
import styles from './invoice.module.css';

function money(v: number | null): string {
  if (v === null || v === undefined) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function InvoiceView() {
  const session = useRequireRole(['owner']);
  const params = useSearchParams();
  const clientId = params.get('client') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';

  const q = useClientInvoice(clientId, from, to);
  if (!session) return null;

  const inv = q.data?.invoice;

  return (
    <div className={styles.page}>
      <div className={`${styles.toolbar} no-print`}>
        <Button icon={<Printer size={16} />} onClick={() => window.print()} disabled={!inv}>
          Печать
        </Button>
        <Button variant="subtle" onClick={() => window.close()}>
          Закрыть
        </Button>
      </div>

      {q.isPending && (
        <div className={styles.doc}>
          <Skeleton height={22} width="50%" />
          <Skeleton height={14} width="70%" />
          <Skeleton height={200} radius={8} />
        </div>
      )}

      {q.isError && !inv && (
        <Empty
          icon={<TriangleAlert size={28} />}
          title="Не удалось сформировать счёт"
          hint={q.error?.message}
          action={<Button variant="ghost" onClick={() => q.refetch()}>Повторить</Button>}
        />
      )}

      {inv && (
        <div className={styles.doc}>
          <div className={styles.head}>
            <div className={styles.docTitle}>Счёт за услуги прачечной</div>
            <div className={styles.period}>
              Период: {formatDateRu(inv.from)} — {formatDateRu(inv.to)}
            </div>
          </div>

          <div className={styles.client}>
            <div className={styles.clientName}>{inv.client.name}</div>
            {inv.client.inn && (
              <div>
                ИНН {inv.client.inn}
                {inv.client.kpp ? ` / КПП ${inv.client.kpp}` : ''}
              </div>
            )}
            {inv.client.legal_address && <div>{inv.client.legal_address}</div>}
          </div>

          {inv.missing_prices.length > 0 && (
            <div className={`${styles.warn} no-print`}>
              <TriangleAlert size={14} /> У {inv.missing_prices.length}{' '}
              {inv.missing_prices.length === 1 ? 'позиции' : 'позиций'} нет цены — они в счёте без
              суммы. Задайте цены в справочнике (вкладка «Прайс» или карточка клиента).
            </div>
          )}

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Наименование</th>
                <th>Код НФ</th>
                <th>Ед.</th>
                <th className={styles.right}>Кол-во</th>
                <th className={styles.right}>Цена</th>
                <th className={styles.right}>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.billing_item_id}>
                  <td>{l.name}</td>
                  <td>{l.ext_code || '—'}</td>
                  <td>{l.unit}</td>
                  <td className={styles.right}>{l.qty}</td>
                  <td className={styles.right}>{money(l.price)}</td>
                  <td className={styles.right}>{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className={styles.right}>
                  Итого
                </td>
                <td className={`${styles.right} ${styles.total}`}>{money(inv.total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
