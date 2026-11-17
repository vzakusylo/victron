'use strict';

const { test, expect } = require('@playwright/test');

test('every dashboard page renders without browser console errors', async ({ page }) => {
    const errors = [];
    page.on('console', message => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', error => errors.push(`page error: ${error.message}`));

    await page.goto('./', { waitUntil: 'domcontentloaded' });
    const menuItems = page.locator('md-sidenav md-list-item');
    await expect(menuItems.first()).toBeAttached();

    if (!(await menuItems.first().isVisible())) {
        await page.getByRole('button', { name: 'menu button' }).click();
    }

    const pages = await menuItems.evaluateAll(items => items
        .filter(item => item.getAttribute('aria-disabled') !== 'true')
        .map((item, index) => ({ index, name: item.innerText.trim() })));
    expect(pages.length, 'dashboard should expose at least one enabled page').toBeGreaterThan(0);

    for (const { index, name } of pages) {
        const item = menuItems.nth(index);
        if (!(await item.isVisible())) {
            await page.getByRole('button', { name: 'menu button' }).click();
        }
        await item.click();
        await expect(item).toHaveClass(/nr-menu-item-active/, { timeout: 15_000 });
        await expect(page.locator('#toolbar h1')).toHaveText(/\S/, { timeout: 15_000 });
        await expect(
            page.locator('md-content > div[id^="Tab_"], md-content > .node-red-ui--inline-link')
        ).toBeVisible({ timeout: 15_000 });
        console.log(`Checked dashboard page: ${name}`);
    }

    expect(errors, 'browser errors while visiting dashboard pages').toEqual([]);
});
