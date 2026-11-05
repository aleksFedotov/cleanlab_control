import { test, expect, type Page } from '@playwright/test';

type TestSession = { token: string; role: string; laundryId: string };

test.use({ timezoneId: 'Europe/Moscow' });

for (const width of [1280, 390]) {
  test(`владелец распределяет развоз между двумя водителями (${width}px)`, async ({ page, browser, request }, testInfo) => {
    const call = async (method: string, ...args: unknown[]) => {
      const response = await request.post(`http://localhost:3101/api/${method}`, { data: { args } });
      expect(response.ok()).toBeTruthy();
      const result = await response.json();
      expect(result.ok, result.error).toBeTruthy();
      return result;
    };
    // Проксируем в настоящий тестовый Express, независимо от API_ORIGIN
    // локальной сборки. Данные и команды не подменяются.
    const open = async (target: Page, session: TestSession, path: string) => {
      await target.addInitScript(s => {
        localStorage.setItem('cl_token', s.token);
        localStorage.setItem('cl_role', s.role);
        localStorage.setItem('cl_laundry', s.laundryId);
      }, session);
      await target.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        await route.fulfill({ response: await route.fetch({ url: `http://localhost:3101${path}` }) });
      });
      await target.goto(path);
    };
    const owner = await call('login', 'boss', 'boss-pass');
    const suffix = `${width}-${Date.now()}`;
    const drivers: Array<{ id: string; session: TestSession }> = [];
    for (const n of [1, 2]) {
      const login = `route-${suffix}-${n}`;
      const result = await call('createUser', owner.token, {
        name: `Водитель ${suffix}-${n}`, role: 'driver', laundryId: owner.laundryId,
        login, password: 'driver-test-pass',
      });
      drivers.push({ id: result.user.id, session: await call('login', login, 'driver-test-pass') });
    }
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
    const visits: Array<{ id: string; name: string }> = [];
    for (const name of ['А', 'Б', 'Без назначения']) {
      const result = await call('saveClient', owner.token, { name: `${name} ${suffix}`, type: 'отель' });
      const visit = await call('addDeliveryVisit', owner.token, result.client.id, date);
      await call('setPickupOnly', owner.token, visit.visit.id, true);
      visits.push({ id: visit.visit.id, name: result.client.name });
    }
    await page.setViewportSize({ width, height: 900 });
    await open(page, owner, '/delivery');
    await page.getByLabel(`Водитель: ${visits[0].name}`, { exact: true }).selectOption(drivers[0].id);
    await expect(page.getByLabel(`Водитель: ${visits[0].name}`, { exact: true })).toBeEnabled();
    await page.getByLabel(`Водитель: ${visits[1].name}`, { exact: true }).selectOption(drivers[1].id);
    await expect(page.getByLabel(`Водитель: ${visits[1].name}`, { exact: true })).toBeEnabled();
    await page.getByRole('combobox', { name: 'Водитель', exact: true }).selectOption(drivers[0].id);
    await expect(page.getByText(visits[0].name, { exact: true })).toBeVisible();
    await expect(page.getByText(visits[1].name, { exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Водитель', exact: true }).selectOption('all');
    await page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true }).check();
    await page.getByLabel(`Выбрать точку: ${visits[1].name}`, { exact: true }).check();
    await expect(page.getByRole('status').filter({ hasText: 'Выбрано: 2' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Водитель для выбранных точек', exact: true }).selectOption(drivers[0].id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const dock = page.getByRole('region', { name: 'Назначение выбранных точек', exact: true });
    const assertDockInViewport = async () => {
      const bounds = await dock.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(901);
    };
    await assertDockInViewport();
    await page.screenshot({ path: testInfo.outputPath('bulk-selection.png'), fullPage: false });
    await page.getByRole('button', { name: /Добавить в сегодняшний развоз/ }).scrollIntoViewIfNeeded();
    await assertDockInViewport();
    await page.getByRole('button', { name: 'Назначить', exact: true }).click();
    await expect(page.getByLabel(`Водитель: ${visits[1].name}`, { exact: true })).toHaveValue(drivers[0].id);
    await expect(page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true })).not.toBeChecked();
    // Selection follows filters and does not reappear when returning to a filter.
    await page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true }).check();
    await page.getByRole('combobox', { name: 'Водитель', exact: true }).selectOption(drivers[0].id);
    await expect(page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true })).not.toBeChecked();
    await page.getByLabel('Выбрать все', { exact: true }).check();
    await expect(page.getByRole('status').filter({ hasText: 'Выбрано: 2' })).toBeVisible();
    await page.getByRole('button', { name: 'Снять выбор', exact: true }).click();
    await page.getByRole('combobox', { name: 'Водитель', exact: true }).selectOption('all');
    await expect(page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true })).not.toBeChecked();
    // Keyboard selection and a race: the owner sees an error without a partial assignment.
    const checkbox = page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await page.getByLabel(`Выбрать точку: ${visits[1].name}`, { exact: true }).check();
    await call('driverAction', drivers[0].session.token, visits[0].id, 'pickup_dirty', 1);
    await page.getByRole('combobox', { name: 'Водитель для выбранных точек', exact: true }).selectOption(drivers[1].id);
    await page.getByRole('button', { name: 'Назначить', exact: true }).click();
    await expect(page.getByText(/Обновите список и выберите точки заново/)).toBeVisible();
    await expect(page.getByLabel(`Выбрать точку: ${visits[0].name}`, { exact: true })).toHaveCount(0);
    await expect(page.getByLabel(`Водитель: ${visits[1].name}`, { exact: true })).toHaveValue(drivers[0].id);
    await call('correctVisit', owner.token, visits[0].id, 'undo_pickup');
    await call('assignDeliveryDrivers', owner.token, [visits[0].id, visits[1].id], drivers[1].id);
    await call('assignDeliveryDriver', owner.token, visits[0].id, drivers[0].id);
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath('delivery.png'), fullPage: true });

    const firstContext = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: 'Europe/Moscow' });
    const secondContext = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: 'Europe/Moscow' });
    try {
      const first = await firstContext.newPage();
      const second = await secondContext.newPage();
      await open(first, drivers[0].session, '/driver');
      await open(second, drivers[1].session, '/driver');
      await expect(first.getByText(visits[0].name, { exact: true })).toBeVisible();
      await expect(first.getByText(visits[1].name, { exact: true })).toHaveCount(0);
      await expect(first.getByText(visits[2].name, { exact: true })).toHaveCount(0);
      await expect(second.getByText(visits[1].name, { exact: true })).toBeVisible();
      await expect(second.getByText(visits[0].name, { exact: true })).toHaveCount(0);

      await first.getByText(visits[0].name, { exact: true }).click();
      await first.getByRole('dialog').getByRole('button', { name: 'Забрал грязное', exact: true }).click();
      await expect.poll(async () => (await call('getDriverRoute', drivers[0].session.token, date)).cargo.dirty_points).toBe(1);
      expect((await call('getDriverRoute', drivers[1].session.token, date)).cargo.dirty_points).toBe(0);
      await page.reload();
      await expect(page.getByLabel(`Водитель: ${visits[0].name}`, { exact: true })).toBeDisabled();
      await page.getByLabel(`Водитель: ${visits[1].name}`, { exact: true }).selectOption('');
      await expect(page.getByLabel(`Водитель: ${visits[1].name}`, { exact: true })).toBeEnabled();
      await second.reload();
      await expect(second.getByText('Нет назначенных точек', { exact: true })).toBeVisible();
      await expect(second.getByText(visits[1].name, { exact: true })).toHaveCount(0);
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  });
}
