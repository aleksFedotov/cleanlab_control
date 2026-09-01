import { test, expect, Page } from '@playwright/test';

// P2.1: UX формы клиента в «Справочниках».
// Сьюта последовательная: тест 1 создаёт клиента, тест 2 — позиции прайса,
// остальные работают с созданными данными.

const CLIENT_NAME = 'E2E Клиент';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByPlaceholder('Логин').fill('boss');
  await page.getByPlaceholder('Пароль').fill('boss-pass');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).toHaveURL(/\/today/);
  await page.goto('/refs');
  await expect(page.getByRole('button', { name: 'Добавить клиента' }).first()).toBeVisible();
}

// Клик по кнопке добавления (их две: в шапке и в пустом состоянии)
async function clickAdd(page: Page, name: string) {
  await page.getByRole('button', { name }).first().click();
}

// Открыть модалку клиента по строке списка
async function openClient(page: Page) {
  await page.getByText(CLIENT_NAME, { exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe.serial('форма клиента (P2.1)', () => {
  test('создание: только поля карточки, валидация ИНН, создание', async ({ page }) => {
    await login(page);
    await clickAdd(page, 'Добавить клиента');
    const dialog = page.getByRole('dialog');

    // Секций существующего клиента нет
    await expect(dialog.getByRole('button', { name: /Цены/ })).toHaveCount(0);
    await expect(dialog.getByText('Счёт за период')).toHaveCount(0);

    await dialog.getByPlaceholder('Название *').fill(CLIENT_NAME);

    // Реквизиты свёрнуты; раскрываем и вводим невалидный ИНН
    await dialog.getByRole('button', { name: /Реквизиты/ }).click();
    await dialog.getByPlaceholder('ИНН').fill('12345');
    await dialog.getByRole('button', { name: 'Создать' }).click();
    await expect(dialog.getByText('ИНН — 10 или 12 цифр')).toBeVisible();
    // Не сохранилось — модалка открыта
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder('ИНН').fill('');
    await dialog.getByRole('button', { name: 'Создать' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(CLIENT_NAME, { exact: true })).toBeVisible();
  });

  test('подготовка прайса: дефолтная цена весовой позиции', async ({ page }) => {
    await login(page);
    await page.getByRole('button', { name: 'Прайс' }).click();
    // Сидированный прайс: единственная весовая позиция без дефолтной цены — задаём
    const cell = page.getByLabel('Дефолтная цена: Услуги прачечной (постельное бельё)');
    await cell.fill('100');
    await cell.press('Tab');
    await expect(page.getByText('Цена сохранена')).toBeVisible();
  });

  test('редактирование: сводки, мгновенное сохранение, прайс', async ({ page }) => {
    await login(page);
    let dialog = await openClient(page);

    // Аккордеоны свёрнуты, сводки корректны
    const pricesAcc = dialog.getByRole('button', { name: /Цены/ });
    const bindingsAcc = dialog.getByRole('button', { name: /Привязка видов белья/ });
    await expect(pricesAcc).toHaveAttribute('aria-expanded', 'false');
    await expect(bindingsAcc).toHaveAttribute('aria-expanded', 'false');
    await expect(pricesAcc).toContainText('6 без цены');
    await expect(bindingsAcc).toContainText('все по весу / как у типа');

    // Мгновенное сохранение текстового поля
    await dialog.getByPlaceholder('Адрес').fill('ул. Тестовая, 1');
    await dialog.getByPlaceholder('Адрес').press('Tab');
    await expect(dialog.getByText('✓ Сохранено').first()).toBeVisible();

    // «Закрыть» не откатывает сохранённое
    await dialog.getByRole('button', { name: 'Закрыть' }).click();
    dialog = await openClient(page);
    await expect(dialog.getByPlaceholder('Адрес')).toHaveValue('ул. Тестовая, 1');

    // Прайс: позиции без цены видны сразу, с дефолтом («…постельное бельё») — под спойлером
    await dialog.getByRole('button', { name: /Цены/ }).click();
    await expect(dialog.getByText('Услуги прачечной (Халат)')).toBeVisible();
    await expect(dialog.getByText('не задана').first()).toBeVisible();
    await expect(dialog.getByText('Услуги прачечной (постельное бельё)')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Показать все позиции (7)' }).click();
    await expect(dialog.getByText('Услуги прачечной (постельное бельё)')).toBeVisible();
    await expect(dialog.getByText('наследовано')).toBeVisible();

    // Правка цены — «✓ Сохранено» без перезагрузки
    await dialog.getByLabel('Цена клиента: Услуги прачечной (Халат)').fill('25');
    await dialog.getByLabel('Цена клиента: Услуги прачечной (Халат)').press('Tab');
    await expect(dialog.getByText('✓ Сохранено').first()).toBeVisible();

    // «Закрыть» после правки — цена не откатилась
    await dialog.getByRole('button', { name: 'Закрыть' }).click();
    dialog = await openClient(page);
    const pricesAcc2 = dialog.getByRole('button', { name: /Цены/ });
    await expect(pricesAcc2).toContainText('1 переопределена');
    // Состояние аккордеона персистится: он уже может быть раскрыт с прошлого открытия
    if ((await pricesAcc2.getAttribute('aria-expanded')) === 'false') await pricesAcc2.click();
    await expect(dialog.getByLabel('Цена клиента: Услуги прачечной (Халат)')).toHaveValue('25');
    await expect(dialog.getByText('переопределено')).toBeVisible();
  });

  test('счёт: пилюля «Прошлый» формирует ссылку прошлого месяца', async ({ page }) => {
    await login(page);
    const dialog = await openClient(page);

    // Ожидаемый диапазон — прошлый календарный месяц
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    await dialog.getByRole('button', { name: 'Прошлый' }).click();
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      dialog.getByRole('button', { name: 'Сформировать' }).click(),
    ]);
    expect(popup.url()).toContain(`/invoice?`);
    expect(popup.url()).toContain(`from=${iso(first)}`);
    expect(popup.url()).toContain(`to=${iso(last)}`);
    await popup.close();
  });
});
