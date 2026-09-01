import { expect, test } from '@playwright/test';

test.describe('DisRunner simulator', () => {
  test('runs local command states and exposes the timing inspector', async ({ page }) => {
    await page.setViewportSize({ width: 1678, height: 941 });
    await page.goto('/');

    await expect(page.getByText('Simulator traffic is local')).toBeVisible();
    await expect(page.getByText('Imported bot code is not OS-sandboxed.')).toBeVisible();
    await expect(page.getByText('3.000 s deadline')).toBeVisible();
    await page.getByRole('button', { name: 'Start bot' }).click();
    await expect(page.getByText('Running', { exact: true })).toBeVisible();

    const composer = page.getByRole('textbox', { name: 'Message #bot-testing' });
    await composer.fill('/slow');
    await composer.press('Enter');
    await expect(page.getByText('Deferred follow-up completed')).toBeVisible();
    await expect(page.getByText("Here's the result you asked for.").last()).toBeVisible();

    await composer.fill('/permissions');
    await composer.press('Enter');
    await expect(page.getByRole('tab', { name: 'Permissions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText('Permission decision tree')).toBeVisible();
  });

  test('switches virtual guilds and opens all required product surfaces', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Sandbox Arena/ }).click();
    await expect(page.getByRole('main', { name: 'Virtual channel general' })).toBeVisible();

    for (const surface of [
      'Guild Editor',
      'Scenario Lab',
      'Command Explorer',
      'Risk Center',
      'Settings',
    ]) {
      await page.getByRole('button', { name: surface }).click();
      await expect(page.getByRole('heading', { name: surface })).toBeVisible();
    }
  });
});
