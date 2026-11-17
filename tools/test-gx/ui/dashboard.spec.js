'use strict';

const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const pages = require('./pages.json');
const allowlist = require('./console-allowlist.json');

execFileSync(process.execPath, [path.join(__dirname, 'gen-pages.js'), '--check'], { stdio: 'inherit' });

const registered = pages.filter(entry => entry.route).sort((a, b) =>
    Number(a.route.slice(3)) - Number(b.route.slice(3)));
const menu = registered.filter(entry => !entry.hidden);
const visible = menu.map((entry, index) => ({ ...entry, menuIndex: index }))
    .filter(entry => !entry.disabled);

async function openDashboard(page, errors) {
    page.on('console', message => {
        if (message.type() === 'error') errors.push({ type: 'console', text: message.text() });
    });
    page.on('pageerror', error => errors.push({ type: 'pageerror', text: error.message }));
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    const items = page.locator('md-sidenav md-list-item');
    await expect(items.first()).toBeAttached();
    if (!(await items.first().isVisible())) {
        await page.getByRole('button', { name: 'menu button' }).click();
    }
    return items;
}

function assertNoErrors(errors) {
    const unexpected = errors.filter(error =>
        !allowlist.some(allowed => allowed.type === error.type && allowed.text === error.text));
    expect(unexpected, 'unexpected browser console or page errors').toEqual([]);
}

test('runtime menu matches the page inventory', async ({ page }) => {
    const errors = [];
    try {
        const items = await openDashboard(page, errors);
        await expect(items).toHaveText(menu.map(entry => entry.name));
    } finally {
        assertNoErrors(errors);
    }
});

for (const entry of visible) {
    test(`${entry.name} (${entry.id}) renders without browser errors`, async ({ page }) => {
        const errors = [];
        try {
            const items = await openDashboard(page, errors);
            const item = items.nth(entry.menuIndex);
            await expect(item).toHaveText(entry.name);
            await item.click();
            await expect(item).toHaveClass(/nr-menu-item-active/);
            await expect(page).toHaveURL(new RegExp(`${entry.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
            await expect(page.locator('#toolbar h1[node-id]').filter({ hasText: entry.name })).toBeVisible();
            await expect(page.locator('ui-card-panel ui-component').first()).toBeVisible();
            await page.waitForTimeout(2000);
        } finally {
            assertNoErrors(errors);
        }
    });
}
