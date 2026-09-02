import { test, expect } from '@playwright/test';

// Критический сценарий: вход владельца → дашборд «Сегодня», выход → /login.
test('логин владельца и выход', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Логин').fill('boss');
  await page.getByPlaceholder('Пароль').fill('boss-pass');
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page).toHaveURL(/\/today/);
  // Сайдбар с навигацией владельца
  await expect(page.getByRole('link', { name: 'Сегодня' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Стирка' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Отчёт', exact: true })).toBeVisible();

  // Выход через сайдбар
  await page.getByRole('button', { name: 'Выход' }).click();
  await expect(page).toHaveURL(/\/login/);
});

test('неверный пароль — ошибка, остаёмся на /login', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Логин').fill('boss');
  await page.getByPlaceholder('Пароль').fill('wrong');
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByText('Неверный логин или пароль')).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
