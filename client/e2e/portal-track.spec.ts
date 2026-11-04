import { test, expect, Page, APIRequestContext } from '@playwright/test';

// P1, этап 4: трекинг сдачи в портале — проход от «Заявка принята» до «Доставлено».
// Сид (beforeAll): клиент + доступ + визит на сегодня + заявка с позициями.
// Переходы состояний поднимаются через API (как в unit-тестах сервера),
// UI проверяет трек после каждого ключевого события.

const CLIENT_NAME = 'E2E Трек Клиент';
const PORTAL_LOGIN = 'e2e-track';
const PORTAL_PASS = 'e2e-track-pass';

function dayStr(base: Date, days: number): string {
  const d = new Date(base.getTime() + days * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const NOW = new Date();
const TODAY = dayStr(NOW, 0);
const YESTERDAY = dayStr(NOW, -1);
const TOMORROW = dayStr(NOW, 1);

let CLIENT_ID = '';
let REQUEST_ID = '';
let VISIT_ID = '';

async function api(request: APIRequestContext, method: string, args: unknown[]) {
  const res = await request.post(`/api/${method}`, { data: { args } });
  const body = await res.json();
  if (!body || body.ok === false) throw new Error(`${method}: ${body && body.error}`);
  return body;
}

async function loginPortal(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('Логин').fill(PORTAL_LOGIN);
  await page.getByPlaceholder('Пароль').fill(PORTAL_PASS);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/portal/);
}

// Открываем карточку заявки (форма + трек) из списка
async function openRequestTrack(page: Page) {
  await page.getByRole('button', { name: 'Мои заявки' }).click();
  await page.locator('button', { hasText: 'меш.' }).first().click();
  await expect(page.getByTestId('track')).toBeVisible();
}

test.describe.serial('портал клиента: трекинг сдачи (P1, этап 4)', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test.beforeAll(async ({ request }) => {
    const login = await api(request, 'login', ['boss', 'boss-pass']);
    const owner = login.token as string;
    const client = await api(request, 'saveClient', [owner, { name: CLIENT_NAME, type: 'отель' }]);
    CLIENT_ID = client.client.id as string;
    await api(request, 'setClientAccess', [owner, CLIENT_ID, PORTAL_LOGIN, PORTAL_PASS]);
    const visit = await api(request, 'addDeliveryVisit', [owner, CLIENT_ID, TODAY]);
    VISIT_ID = visit.visit.id as string;
    const portalLogin = await api(request, 'login', [PORTAL_LOGIN, PORTAL_PASS]);
    const reqRes = await api(request, 'clientCreateRequest', [
      portalLogin.token, 2, '', [{ item_type_id: 'itm_2', qty: 5 }],
    ]);
    REQUEST_ID = reqRes.request.id as string;
    await api(request, 'linkRequestToVisit', [owner, REQUEST_ID, VISIT_ID]);
  });

  test('старт: «Водитель направляется», факт ещё не показан (подсказка, не нули)', async ({
    page,
  }) => {
    await loginPortal(page);
    await openRequestTrack(page);

    // 8 шагов, первый («Заявка принята») пройден, текущий — «Водитель направляется»
    await expect(page.getByTestId('track-current')).toHaveText('Водитель направляется');
    await expect(page.locator('[data-testid=track] li')).toHaveCount(8);
    await expect(page.locator('[data-testid=track] li').first()).toHaveAttribute('data-done', 'true');
    await expect(page.locator('[data-testid=track] li').nth(1)).toHaveAttribute('data-done', 'true');

    // До стирки — честная подсказка, без нулей
    await expect(page.getByText('После стирки здесь появится фактический пересчёт')).toBeVisible();
    await expect(page.getByTestId('track-fact')).toHaveCount(0);
  });

  test('после забора водителем: «На пути в прачечную» с датой события', async ({ page, request }) => {
    const login = await api(request, 'login', ['boss', 'boss-pass']);
    await api(request, 'driverAction', [login.token, VISIT_ID, 'pickup_dirty']);

    await loginPortal(page);
    await openRequestTrack(page);
    await expect(page.getByTestId('track-current')).toHaveText('На пути в прачечную');
    const currentStep = page.locator('[data-testid=track] li', { hasText: 'На пути в прачечную' });
    await expect(currentStep.getByText(/· \d{2}:\d{2}/)).toBeVisible();
    await expect(page.getByText('После стирки здесь появится фактический пересчёт')).toBeVisible();
  });

  test('после стирки: «Готово, на складе» + две колонки «Заявлено / Постирано»', async ({
    page,
    request,
  }) => {
    const login = await api(request, 'login', ['boss', 'boss-pass']);
    const owner = login.token as string;
    // Стирка дня порождается чтением вчерашнего дня (визит сегодня → стирка вчера)
    const day = await api(request, 'getDayList', [owner, YESTERDAY]);
    const wash = day.washes.find((w: { client_id: string }) => w.client_id === CLIENT_ID);
    expect(wash, 'стирка создана').toBeTruthy();
    await api(request, 'startWash', [owner, wash.id, 9]);
    await api(request, 'completeWash', [
      owner, wash.id, [{ item_type_id: 'itm_2', qty: 5 }], 8, '', 2,
    ]);

    await loginPortal(page);
    await openRequestTrack(page);
    await expect(page.getByTestId('track-current')).toHaveText('Готово, на складе');

    // Факт: позиции, кг, мешки; заявленное рядом
    const fact = page.getByTestId('track-fact');
    await expect(fact).toContainText('Заявлено');
    await expect(fact).toContainText('Постирано');
    await expect(fact).toContainText('простыня');
    await expect(fact).toContainText('×5');
    await expect(fact).toContainText('8 кг');
  });

  test('доставка: чистое уехало следующим визитом → «Направляется к вам» → «Доставлено»', async ({
    page,
    request,
  }) => {
    const login = await api(request, 'login', ['boss', 'boss-pass']);
    const owner = login.token as string;
    const visitOut = await api(request, 'addDeliveryVisit', [owner, CLIENT_ID, TOMORROW]);
    await api(request, 'driverTakeAllClean', [owner, TOMORROW]);

    await loginPortal(page);
    await openRequestTrack(page);
    await expect(page.getByTestId('track-current')).toHaveText('Направляется к вам');

    await api(request, 'driverAction', [owner, visitOut.visit.id, 'deliver_clean']);
    await page.reload();
    await openRequestTrack(page);
    await expect(page.getByTestId('track-current')).toHaveText('Доставлено');
    // Все 8 шагов пройдены
    await expect(page.locator('[data-testid=track] li[data-done]')).toHaveCount(8);
    // Факт остался на месте
    await expect(page.getByTestId('track-fact')).toContainText('8 кг');
  });
});
