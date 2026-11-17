'use strict';

const { test, expect } = require('@playwright/test');
const pages = require('./pages.json');
const allowlist = require('./console-allowlist.json');

const registered = pages.filter(entry => entry.route).sort((a, b) =>
    Number(a.route.slice(3)) - Number(b.route.slice(3)));
const menu = registered.filter(entry => !entry.hidden);
const visible = menu.map((entry, index) => ({ ...entry, menuIndex: index }))
    .filter(entry => !entry.disabled);

function pageNamePattern(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = '(?:git [a-f0-9]{12}|local [a-f0-9]{12}|UI (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded); Auto (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded))';
    return new RegExp(`^\\s*${escaped}(?: \\[${source}\\](?: TEST-GX)?)?\\s*$`);
}

async function openDashboard(page, errors) {
    page.on('console', message => {
        if (message.type() === 'error') {
            errors.push({ type: 'console', text: message.text(), url: message.location().url });
        }
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

function unexpectedErrors(errors) {
    return errors.filter(error =>
        !allowlist.some(allowed => allowed.type === error.type && allowed.text === error.text && allowed.url === error.url));
}

function assertNoErrors(errors) {
    expect.soft(unexpectedErrors(errors), 'unexpected browser console or page errors').toEqual([]);
}

test('runtime menu matches the page inventory', async ({ page }) => {
    const errors = [];
    try {
        const items = await openDashboard(page, errors);
        await expect(items).toHaveText(menu.map(entry => pageNamePattern(entry.name)));
    } finally {
        assertNoErrors(errors);
    }
});

for (const entry of visible) {
    test(`${entry.name} (${entry.id}) renders without browser errors`, async ({ page }) => {
        if (entry.id === 'ui-tab-heatpump-01') {
            // expected_fail: Angular $parse:syntax in hp-hist-template-01 vertical-align expression — see flows-hp-template-parse
            test.fail();
        }
        const errors = [];
        try {
            const items = await openDashboard(page, errors);
            const item = items.nth(entry.menuIndex);
            await expect(item).toHaveText(pageNamePattern(entry.name));
            await item.click();
            await expect(item).toHaveClass(/nr-menu-item-active/);
            await expect(page).toHaveURL(new RegExp(`${entry.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?[^#]*)?$`));
            await expect(page.locator('#toolbar h1[node-id]').filter({ hasText: entry.name })).toBeVisible();
            await expect(page.locator('ui-card-panel:visible md-card[node-id]:visible').first()).toBeVisible();
            await page.waitForTimeout(2000);
        } finally {
            assertNoErrors(errors);
        }
    });
}
