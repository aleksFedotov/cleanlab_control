import { test, expect } from '@playwright/test';

for (const width of [1280, 390]) {
  test(`детализация стирок и смена периода (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('cl_token', 'finance-test');
      localStorage.setItem('cl_role', 'owner');
      localStorage.setItem('cl_laundry', '1');
    });
    await page.route('**/api/getDeliveryVisits', (route) => route.fulfill({ json: { ok: true, visits: [] } }));
    await page.route('**/api/listLaundries', (route) => route.fulfill({ json: { ok: true, laundries: [] } }));
    await page.route('**/api/getFinanceSummary', async (route) => {
      const { args } = route.request().postDataJSON();
      await route.fulfill({ json: {
        ok: true, from: args[1], to: args[2],
        totals: { washes: 3, weight_kg: 60, items_total: 7, amount: 3000 },
        clients: [{
          client_id: 'test', client_name: 'Тестовый клиент', washes: 3, bags: 0,
          weight_kg: 60, items_total: 7, trips: 0, lifts: 0, amount: 3000, missing_prices: 0,
          lines: [{ billing_item_id: 'weight', name: 'Стирка белья', qty: 60, unit: 'кг', price: 50, amount: 3000 }],
          wash_details: [
            { id: 'a', wash_date: '2026-10-16', weight_kg: 20, items_total: 7, items: [
              { item_type_id: 'p', item_name: 'Подушка', qty: 2 },
              { item_type_id: 'b', item_name: 'Одеяло', qty: 5 },
            ] },
            { id: 'b', wash_date: '2026-10-16', weight_kg: 10, items_total: 0, items: [] },
            { id: 'c', wash_date: '2026-10-31', weight_kg: 30, items_total: 0, items: [] },
          ],
        }],
      } });
    });
    await page.goto('/finance');
    await page.getByRole('button', { name: 'Период', exact: true }).click();
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill('2026-10-16');
    await dates.nth(1).fill('2026-10-31');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    const expand = page.getByRole('button', { name: 'Подробности: Тестовый клиент' });
    await expand.focus();
    await expand.press('Enter');
    const section = page.getByRole('region', { name: 'Стирки за период' });
    await expect(section).toBeVisible();
    const summaries = section.locator('summary');
    await expect(summaries).toHaveCount(3);
    await expect(summaries.nth(0)).toContainText('16 октября 2026');
    await summaries.nth(0).focus();
    await summaries.nth(0).press('Enter');
    await expect(section.getByText('Подушка — 2 шт.')).toBeVisible();
    await expect(section.getByText('Одеяло — 5 шт.')).toBeVisible();
    await summaries.nth(1).click();
    await expect(section.getByText('Состав вещей не указан').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Открыть счёт' })).toHaveAttribute('href', '/invoice?client=test&from=2026-10-16&to=2026-10-31');
    await dates.nth(0).fill('2026-10-17');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expand.click();
    await expect(section.locator('details[open]')).toHaveCount(0);
  });
}
