import { test, expect, Page, Locator, APIRequestContext } from '@playwright/test';

// P1, этап 3: форма заявки в портале клиента.
// Дату клиент не выбирает: заявка всегда «на сегодня» (день, когда сняли бельё).
// Сид (beforeAll): клиент + доступ в портал + planned-визит на завтра.
// Сьюта последовательная: тест 1 создаёт заявку, тест 3 её правит, тест 4
// поднимает статус в picked через API (визит + привязка + driverAction).

const CLIENT_NAME = 'E2E Портал Клиент';
const PORTAL_LOGIN = 'e2e-portal';
const PORTAL_PASS = 'e2e-portal-pass';

function todayStr(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function shift(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const TODAY = todayStr();
const TOMORROW = shift(TODAY, 1);

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

// Степпер внутри блока с подписью (Мешки / строка вида белья)
function stepperIn(scope: Locator) {
  return {
    plus: scope.getByRole('button', { name: '+', exact: true }),
    minus: scope.getByRole('button', { name: '−', exact: true }),
    input: scope.locator('input'),
  };
}

test.describe.serial('портал клиента: заявка на сдачу (P1, этап 3)', () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test.beforeAll(async ({ request }) => {
    const login = await api(request, 'login', ['boss', 'boss-pass']);
    const owner = login.token as string;
    const client = await api(request, 'saveClient', [owner, { name: CLIENT_NAME, type: 'отель' }]);
    const clientId = client.client.id as string;
    await api(request, 'setClientAccess', [owner, clientId, PORTAL_LOGIN, PORTAL_PASS]);
    await api(request, 'addDeliveryVisit', [owner, clientId, TOMORROW]);
  });

  test('создание с нуля: дата — всегда сегодня, степперы, отправка → список', async ({
    page,
  }) => {
    await loginPortal(page);

    // Дата не выбирается: фиксированная строка «Сегодня, …»
    await expect(page.getByTestId('pickup-date')).toContainText('Сегодня');
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    // Визит завтра — подсказка про ближайший визит
    await expect(page.getByText('Водитель заберёт бельё в ближайший визит')).toBeVisible();

    // Виды белья — сидированный справочник (простыня есть)
    const sheetRow = page.locator('[data-item-type="простыня"]');
    const st = stepperIn(sheetRow);
    await st.plus.click();
    await st.plus.click();
    await st.minus.click();
    await expect(st.input).toHaveValue('1');

    // Мешки: крупный степпер
    const bs = stepperIn(page.getByTestId('bags-field'));
    await bs.plus.click();
    await bs.plus.click();
    await expect(bs.input).toHaveValue('2');

    await page.getByPlaceholder('Например: забрать до 12:00').fill('забрать до 12');
    await page.getByRole('button', { name: 'Отправить заявку' }).click();

    // После отправки — список заявок с карточкой
    await expect(page.getByText('Заявка отправлена')).toBeVisible();
    await expect(page.getByText('Мои заявки').first()).toBeVisible();
    const card = page.locator('button', { hasText: 'Принята' });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('2 меш.');
    await expect(card).toContainText('простыня ×1');
    await expect(card).toContainText('забрать до 12');
  });

  test('степперы: ручной ввод числа, кнопки −/+', async ({ page }) => {
    await loginPortal(page);
    const st = stepperIn(page.locator('[data-item-type="простыня"]'));
    await st.input.fill('7');
    await expect(st.input).toHaveValue('7');
    await st.plus.click();
    await expect(st.input).toHaveValue('8');
    await st.minus.click();
    await st.minus.click();
    await expect(st.input).toHaveValue('6');
  });

  test('правка до забора: префилл из списка, перезапись без дубля', async ({ page }) => {
    await loginPortal(page);
    // Из списка открываем заявку за сегодня → форма с префиллом, редактируемая
    await page.getByRole('button', { name: 'Мои заявки' }).click();
    await page.locator('button', { hasText: 'Принята' }).click();

    await expect(page.getByTestId('pickup-date')).toContainText('Сегодня');
    const bs = stepperIn(page.getByTestId('bags-field'));
    await expect(bs.input).toHaveValue('2');
    await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toBeVisible();

    // Меняем мешки 2 → 5, сохраняем
    await bs.input.fill('5');
    await page.getByRole('button', { name: 'Сохранить изменения' }).click();
    await expect(page.getByText('Заявка обновлена')).toBeVisible();

    // Одна карточка (перезапись, не дубль), новое значение
    const cards = page.locator('button', { hasText: 'Принята' });
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText('5 меш.');
  });

  test('после забора водителем: read-only, правка недоступна', async ({
    page,
    request,
  }) => {
    // Заявка на сегодня + визит + привязка + «Забрал грязное» — всё через API
    const login = await api(request, 'login', ['boss', 'boss-pass']);
    const owner = login.token as string;
    const portalLogin = await api(request, 'login', [PORTAL_LOGIN, PORTAL_PASS]);
    const portal = portalLogin.token as string;

    // Клиент порта — из справочника (сид из beforeAll)
    const refs = await api(request, 'getRefs', [owner]);
    const me = refs.clients.find((c: { name: string }) => c.name === CLIENT_NAME);
    const reqRes = await api(request, 'clientCreateRequest', [portal, 3, 'срочно', []]);
    const visit = await api(request, 'addDeliveryVisit', [owner, me.id, TODAY]);
    await api(request, 'linkRequestToVisit', [owner, reqRes.request.id, visit.visit.id]);
    await api(request, 'driverAction', [owner, visit.visit.id, 'pickup_dirty']);

    await loginPortal(page);
    await page.getByRole('button', { name: 'Мои заявки' }).click();

    // Заявка на сегодня в статусе «Забрана»
    const pickedCard = page.locator('button', { hasText: 'Забрана' }).first();
    await expect(pickedCard).toBeVisible();
    await expect(pickedCard).toContainText('3 меш.');

    // Форма read-only: баннер, без степперов и кнопки сохранения
    await pickedCard.click();
    await expect(page.getByText('Забрано водителем — правка недоступна')).toBeVisible();
    await expect(page.getByRole('button', { name: '+', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Сохранить изменения' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Отправить заявку' })).toHaveCount(0);
  });
});
