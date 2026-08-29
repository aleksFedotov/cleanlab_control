// Печатный вид счёта (P2). Отдельный роут вне (dashboard): без сайдбара/хедера —
// так счёт печатается чисто. Параметры: ?client=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD.
import { Suspense } from 'react';
import { InvoiceView } from './invoice-view';

export default function InvoicePage() {
  return (
    <Suspense>
      <InvoiceView />
    </Suspense>
  );
}
