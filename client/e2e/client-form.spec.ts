import { test, expect, Page } from '@playwright/test';

// P2.3: страница клиента вместо модалки.
// Сьюта последовательная: тест 1 создаёт клиента, тест 2 — дефолтную цену
// прайса, остальные работают с созданными данными. Сид: 11 видов белья,
// 7 позиций прайса (4 стирка + 3 логистика).

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

// Клик по строке клиента в списке → страница клиента
async function openClient(page: Page) {
  await page.getByRole('row', { name: new RegExp(CLIENT_NAME) }).click();
  await expect(page).toHaveURL(/\/refs\/clients\/.+/);
  await expect(page.getByRole('heading', { name: CLIENT_NAME })).toBeVisible();
}

test.describe.serial('страница клиента (P2.3)', () => {
  test('создание: в модалке только 3 поля, валидация, переход на страницу + toast', async ({
    page,
  }) => {
    await login(page);
    await page.getByRole('button', { name: 'Добавить клиента' }).first().click();
    const dialog = page.getByRole('dialog');

    // Только Название, Тип, Контакт; подпись про донастройку
    await expect(dialog.getByLabel('Название *')).toBeVisible();
    await expect(dialog.getByLabel('Тип')).toBeVisible();
    await expect(dialog.getByLabel('Контакт')).toBeVisible();
    await expect(dialog.getByPlaceholder('Адрес')).toHaveCount(0);
    await expect(dialog.getByPlaceholder('ИНН')).toHaveCount(0);
    await expect(dialog.getByText('Остальное настроите позже в карточке клиента')).toBeVisible();

    // Пустое название — ошибка, модалка не закрывается
    await dialog.getByRole('button', { name: 'Создать' }).click();
    await expect(dialog.getByText('Укажите название')).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Название *').fill(CLIENT_NAME);
    await dialog.getByRole('button', { name: 'Создать' }).click();

    // Переход на страницу нового клиента + toast
    await expect(page).toHaveURL(/\/refs\/clients\/.+/);
    await expect(page.getByText('Клиент создан')).toBeVisible();
    await expect(page.getByRole('heading', { name: CLIENT_NAME })).toBeVisible();
    await expect(page.getByText('Изменения сохраняются автоматически')).toBeVisible();
  });

  test('список: клик по строке → URL /refs/clients/<id>, заголовок = имя', async ({ page }) => {
    await login(page);
    await openClient(page);
    // Крошки
    await expect(page.getByRole('navigation', { name: 'Хлебные крошки' })).toContainText(
      'Справочники / Клиенты / ' + CLIENT_NAME
    );
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

  test('профиль: мгновенное сохранение, единый индикатор, валидация ИНН', async ({ page }) => {
    await login(page);
    await openClient(page);

    // Правка «Контакт» → blur → «✓ Сохранено · HH:MM» в шапке
    await page.getByPlaceholder('Контакт').fill('+7 999 111-22-33');
    await page.getByPlaceholder('Контакт').press('Tab');
    await expect(page.getByRole('status')).toContainText('Сохранено ·');

    // Обновление страницы — значение на месте
    await page.reload();
    await expect(page.getByPlaceholder('Контакт')).toHaveValue('+7 999 111-22-33');

    // ИНН 5 цифр — ошибка под полем, на сервер не уходит
    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && (r.postData() || '').includes('saveClient')) {
        apiCalls.push(r.url());
      }
    });
    await page.getByRole('button', { name: /Реквизиты/ }).click();
    await page.getByPlaceholder('ИНН').fill('12345');
    await page.getByPlaceholder('ИНН').press('Tab');
    await expect(page.getByText('ИНН — 10 или 12 цифр')).toBeVisible();
    await page.waitForTimeout(500);
    expect(apiCalls).toHaveLength(0);
  });

  test('вкладки: ?tab=prices открывает Цены, сводки в подписях', async ({ page }) => {
    await login(page);
    await openClient(page);
    // Подписи вкладок со сводками: 1 позиция с дефолтом, 6 без цены
    await expect(page.getByRole('tab', { name: /Цены/ })).toContainText('6 без цены');
    await expect(page.getByRole('tab', { name: /Привязки/ })).toContainText(
      'все по весу / как у типа'
    );

    const url = page.url();
    await page.goto(url + '?tab=prices');
    await expect(page.getByRole('tab', { name: /Цены/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Услуги прачечной (Халат)')).toBeVisible();
  });

  test('цены: бейджи только об отклонениях, спойлер, правка без перезагрузки', async ({
    page,
  }) => {
    await login(page);
    await openClient(page);
    await page.getByRole('tab', { name: /Цены/ }).click();

    // Позиции без цены видны сразу, с дефолтом — под спойлером
    await expect(page.getByText('Услуги прачечной (Халат)')).toBeVisible();
    await expect(page.getByText('не задана').first()).toBeVisible();
    await expect(page.getByText('Услуги прачечной (постельное бельё)')).toHaveCount(0);
    await page.getByRole('button', { name: 'Показать все позиции (7)' }).click();
    await expect(page.getByText('Услуги прачечной (постельное бельё)')).toBeVisible();
    // Бейджа «наследовано» больше нет
    await expect(page.getByText('наследовано')).toHaveCount(0);

    // Правка цены — сохранение без перезагрузки, индикатор в шапке
    const priceInput = page.getByLabel('Цена клиента: Услуги прачечной (Халат)');
    await priceInput.fill('25');
    await priceInput.press('Tab');
    await expect(page.getByRole('status')).toContainText('Сохранено ·');
    await expect(page.getByText('переопределено')).toBeVisible();

    // После перезагрузки: бейдж у переопределённой есть, у наследованной — нет
    await page.reload();
    await page.getByRole('tab', { name: /Цены/ }).click();
    await expect(page.getByRole('tab', { name: /Цены/ })).toContainText('1 переопределена');
    await expect(page.getByLabel('Цена клиента: Услуги прачечной (Халат)')).toHaveValue('25');
    await expect(page.getByText('переопределено')).toBeVisible();
    await page.getByRole('button', { name: 'Показать все позиции (7)' }).click();
    await expect(page.getByText('наследовано')).toHaveCount(0);
  });

  test('виды белья: явный режим, чипсы, счётчик, возврат на «все виды»', async ({ page }) => {
    await login(page);
    await openClient(page);

    // Дефолт — «Все виды белья»
    await expect(page.getByRole('button', { name: 'Все виды белья' })).toBeVisible();
    await expect(page.getByText('Работник увидит все активные виды — ограничений нет')).toBeVisible();

    // «Только выбранные» → чипсы видов, счётчик 0 из 11 + предупреждение
    await page.getByRole('button', { name: 'Только выбранные' }).click();
    await expect(page.getByText('Выбрано: 0 из 11')).toBeVisible();
    await expect(page.getByText('работник не увидит ни одного вида')).toBeVisible();

    // Выбор двух видов → счётчик «Выбрано: 2 из 11»
    await page.getByRole('button', { name: 'пододеяльник' }).click();
    await page.getByRole('button', { name: 'простыня' }).click();
    await expect(page.getByText('Выбрано: 2 из 11')).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Сохранено ·');

    // После перезагрузки режим сохранился
    await page.reload();
    await expect(page.getByText('Выбрано: 2 из 11')).toBeVisible();

    // Возврат на «Все виды» → item_types пуст
    await page.getByRole('button', { name: 'Все виды белья' }).click();
    await expect(page.getByRole('status')).toContainText('Сохранено ·');
    await page.reload();
    await expect(
      page.getByText('Работник увидит все активные виды — ограничений нет')
    ).toBeVisible();
  });

  test('архив и возврат: меню «⋯», ConfirmDialog, бейдж «в архиве»', async ({ page }) => {
    await login(page);
    await openClient(page);

    // «В архив» — в меню, с подтверждением
    await page.getByRole('button', { name: 'Действия с клиентом' }).click();
    await page.getByRole('menuitem', { name: 'В архив' }).click();
    const confirmDlg = page.getByRole('dialog');
    await expect(confirmDlg.getByRole('button', { name: 'В архив' })).toBeVisible();
    await confirmDlg.getByRole('button', { name: 'В архив' }).click();

    // После архива — toast и возврат в список
    await expect(page.getByText('Клиент в архиве')).toBeVisible();
    await expect(page).toHaveURL(/\/refs$/);

    // В фильтре «Архив» клиент есть; на странице — бейдж «в архиве»
    await page.getByRole('button', { name: 'Архив', exact: true }).click();
    await openClient(page);
    await expect(page.getByText('в архиве', { exact: true })).toBeVisible();

    // Вернуть из архива — из меню
    await page.getByRole('button', { name: 'Действия с клиентом' }).click();
    await page.getByRole('menuitem', { name: 'Вернуть из архива' }).click();
    await expect(page.getByText('Клиент возвращён из архива')).toBeVisible();
    await expect(page.getByText('в архиве', { exact: true })).toHaveCount(0);
  });

  test('мобильная ширина: вкладки доступны, горизонтального скролла страницы нет', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await login(page);
    await openClient(page);
    await expect(page.getByRole('tab', { name: /Привязки/ })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
