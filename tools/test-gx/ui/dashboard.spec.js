'use strict';

const { test, expect } = require('@playwright/test');
const pages = require('./pages.json');
const allowlist = require('./console-allowlist.json');
const expectedErrors = require('./expected-errors.json');
const { classifyErrors } = require('./error-checks');

const registered = pages.filter(entry => entry.route).sort((a, b) =>
    Number(a.route.slice(3)) - Number(b.route.slice(3)));
const menu = registered.filter(entry => !entry.hidden);
const visible = menu.map((entry, index) => ({ ...entry, menuIndex: index }))
    .filter(entry => !entry.disabled);
for (const id of Object.keys(expectedErrors)) {
    if (!visible.some(entry => entry.id === id)) throw new Error(`Expected-error entry has no visible page: ${id}`);
}

function pageNamePattern(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = '(?:git [a-f0-9]{12}|local [a-f0-9]{12}|UI (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded); Auto (?:[a-f0-9]{12}|local [a-f0-9]{12}|unrecorded))';
    return new RegExp(`^\\s*${escaped}(?: \\[${source}\\](?: TEST-GX)?)?\\s*$`);
}

async function openDashboard(page, errors, timing) {
    page.on('console', message => {
        if (message.type() === 'error') {
            errors.push({ type: 'console', text: message.text(), url: message.location().url,
                phase: timing.clicked ? 'after-first-menu-click' :
                    timing.opening ? 'before-first-menu-click' : 'after-open-before-first-menu-click' });
        }
    });
    page.on('pageerror', error => errors.push({ type: 'pageerror', text: error.message }));
    await page.goto('./', { waitUntil: 'domcontentloaded' });
    const items = page.locator('md-sidenav md-list-item');
    await expect(items.first()).toBeAttached();
    if (!(await items.first().isVisible())) {
        timing.clicked = true;
        await page.getByRole('button', { name: 'menu button' }).click();
    }
    timing.opening = false;
    return items;
}

function assertErrors(errors, expected, timing) {
    const sideNav = errors.filter(error => error.text === "SideNav 'left' is not available! Did you use md-component-id='left'?");
    console.log('SideNav timing:', JSON.stringify({ firstMenuClickStarted: timing.clicked, phases: sideNav.map(error => error.phase) }));
    const result = classifyErrors(errors, allowlist, expected);
    expect.soft(result.unexpected, 'unexpected browser console or page errors').toEqual([]);
    for (const missing of result.missing) {
        expect.soft(false, `expected error not seen — bug fixed? remove entry (${missing.bug}, ${missing.node})`).toBe(true);
    }
}

test('runtime menu matches the page inventory', async ({ page }) => {
    const errors = [];
    const timing = { clicked: false, opening: true };
    try {
        const items = await openDashboard(page, errors, timing);
        await expect(items).toHaveText(menu.map(entry => pageNamePattern(entry.name)));
    } finally {
        assertErrors(errors, [], timing);
    }
});

for (const entry of visible) {
    test(`${entry.name} (${entry.id}) renders without browser errors`, async ({ page }) => {
        const errors = [];
        const timing = { clicked: false, opening: true };
        try {
            const items = await openDashboard(page, errors, timing);
            const item = items.nth(entry.menuIndex);
            await expect(item).toHaveText(pageNamePattern(entry.name));
            timing.clicked = true;
            await item.click();
            await expect(item).toHaveClass(/nr-menu-item-active/);
            await expect(page).toHaveURL(new RegExp(`${entry.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?[^#]*)?$`));
            await expect(page.locator('#toolbar h1[node-id]').filter({ hasText: entry.name })).toBeVisible();
            await expect(page.locator('ui-card-panel:visible md-card[node-id]:visible').first()).toBeVisible();
            await page.waitForTimeout(2000);
        } finally {
            assertErrors(errors, expectedErrors[entry.id] || [], timing);
        }
    });
}

test('Grid control displays live status on Protection', async ({ page }) => {
    const items = await openDashboard(page, [], { clicked: false, opening: true });
    await items.filter({ hasText: pageNamePattern('Protection') }).click();
    const panel = page.getByRole('region', { name: 'Grid control' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Safe mode: not implemented')).toBeVisible();
    await expect(panel.getByRole('rowheader', { name: 'ESS' })).toBeVisible();
    await expect(panel.getByText('Scheduled cadence', { exact: true })).toBeVisible();
    await expect(panel.getByText('Decision reason', { exact: true })).toBeVisible();
    await expect(panel.getByText(/Last status change:/)).toBeVisible();
});
