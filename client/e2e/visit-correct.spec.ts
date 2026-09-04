import { test, expect, Page, APIRequestContext } from '@playwright/test';

// P6: правка визита задним числом — общий модал VisitEditModal.
// Владелец на «Развозе» и водитель в «Истории» отменяют ошибочное действие
// (correctVisit), правят этаж (setVisitLiftFloor) и тут же отмечают правильное.
// Данные готовятся через API (Express :3101 из playwright.config.ts).

const API = 'http://localhost:3101';
const CLIENT1 = 'E2E Правка Один';
const CLIENT2 = 'E2E Правка Два';
const DRIVER_LOGIN = 'e2e-driver';
const DRIVER_PASS = 'driver-pass';

function todayStr() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function apiCall(request: APIRequestContext, method: string, ...args: unknown[]) {
  const res = await request.post(`${API}/api/${method}`, { data: { args } });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.error}`);
  return json;
}

async function loginUi(page: Page, login: string, password: string, landUrl: RegExp) {
  await page.goto('/login');
  await page.getByPlaceholder('Логин').fill(login);
  await page.getByPlaceholder('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(landUrl);
}

test.describe.serial('правка визита задним числом (P6)', () => {
  let ownerToken: string;
  let visit1: string; // для сценария владельца
  let visit2: string; // для сценария водителя

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext();
    const today = todayStr();
    ownerToken = (await apiCall(request, 'login', 'boss', 'boss-pass')).token;
    const c1 = (await apiCall(request, 'saveClient', ownerToken, { name: CLIENT1, type: 'отель' })).client.id;
    const c2 = (await apiCall(request, 'saveClient', ownerToken, { name: CLIENT2, type: 'отель' })).client.id;
    visit1 = (await apiCall(request, 'addDeliveryVisit', ownerToken, c1, today)).visit.id;
    visit2 = (await apiCall(request, 'addDeliveryVisit', ownerToken, c2, today)).visit.id;
    // Водитель для второго сценария
    await apiCall(request, 'createUser', ownerToken, {
      name: 'E2E Водитель', role: 'driver', login: DRIVER_LOGIN, password: DRIVER_PASS, laundryId: '1',
    });
    // Обе точки ошибочно закрыты «Забрал грязное»
    await apiCall(request, 'driverAction', ownerToken, visit1, 'pickup_dirty');
    await apiCall(request, 'driverAction', ownerToken, visit2, 'pickup_dirty');
    await request.dispose();
  });

  test('владелец: развоз → закрытая точка → этаж → отмена → правильное действие', async ({ page }) => {
    await loginUi(page, 'boss', 'boss-pass', /\/today/);
    await page.goto('/delivery');

    // Закрытая карточка кликабельна → модал правки
    await page.getByText(CLIENT1).click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog.getByText('Исправить')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Отменить забор грязного' })).toBeVisible();

    // Этаж: +2 → «Сохранить» → тост
    await dialog.getByRole('button', { name: 'Этаж выше' }).click();
    await dialog.getByRole('button', { name: 'Этаж выше' }).click();
    await dialog.getByRole('button', { name: 'Сохранить' }).click();
    await expect(page.getByText('Этаж сохранён ✓')).toBeVisible();

    // Отмена ошибочного действия с подтверждением
    await dialog.getByRole('button', { name: 'Отменить забор грязного' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Счёт и зарплата за период пересчитаются' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Отменить действие' }).click();
    await expect(page.getByText('Исправлено ✓')).toBeVisible();

    // Модал перерисовался в режим действий — отмечаем правильное, не уходя с экрана
    await expect(dialog.getByRole('button', { name: 'Забрал грязное' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Забрал грязное' }).click();
    await expect(page.getByText('Отмечено ✓')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('водитель: история → точка → отмена → кнопки действий → правильная отметка', async ({ page }) => {
    await loginUi(page, DRIVER_LOGIN, DRIVER_PASS, /\/driver/);

    await page.getByRole('button', { name: 'История' }).click();
    await page.getByText(CLIENT2).click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog.getByRole('button', { name: 'Отменить забор грязного' })).toBeVisible();

    await dialog.getByRole('button', { name: 'Отменить забор грязного' }).click();
    await page.getByRole('button', { name: 'Отменить действие' }).click();
    await expect(page.getByText('Исправлено ✓')).toBeVisible();

    // Появились кнопки действий — фиксируем правильное
    await expect(dialog.getByRole('button', { name: 'Забрал грязное' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Забрал грязное' }).click();
    await expect(page.getByText('Отмечено ✓')).toBeVisible();

    // Точка снова в истории со статусом «Забрано»
    await page.getByRole('button', { name: 'История' }).click();
    await expect(page.getByText(CLIENT2)).toBeVisible();
  });
});
