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

test('Heat Pump charts render missing points and plans without browser errors', async ({ page }) => {
    const errors = [];
    const timing = { clicked: false, opening: true };
    try {
        const items = await openDashboard(page, errors, timing);
        timing.clicked = true;
        await items.filter({ hasText: pageNamePattern('Heat Pump') }).click();
        await expect(page.getByRole('img', { name: 'Boiler curve' })).toBeVisible();
        await expect(page.locator('.hph')).toBeAttached();
        const markers = await page.evaluate(() => {
            const root = window.angular.element(document.body).injector().get('$rootScope');
            const scopes = [root];
            for (const scope of scopes) {
                for (let child = scope.$$childHead; child; child = child.$$nextSibling) scopes.push(child);
            }
            const heat = scopes.find(scope => Object.hasOwn(scope, 'hpCurveReset'));
            const history = scopes.find(scope => Object.hasOwn(scope, 'hpHover'));
            function render(now, plan) {
                root.$apply(() => {
                    const payload = heat.msg.payload;
                    heat.msg = { ...heat.msg, payload: { ...payload,
                        curveChart: { ...payload.curveChart, target: null, svg: { now: null } },
                        dhwChart: { ...payload.dhwChart, svg: { now } }
                    } };
                    history.h.day = { day: '2026-11-25', chart: { t1: 12, b2: 230, plan } };
                });
                const coords = (selector, attr) =>
                    Array.from(document.querySelectorAll(selector), el => el.getAttribute(attr));
                return {
                    heat: coords('svg[aria-label="Heating curve"] circle', 'cy'),
                    boiler: coords('svg[aria-label="Boiler curve"] circle', 'cy'),
                    target: coords('.hph-svg .plan-target', 'y1'),
                    projection: coords('.hph-svg .plan-proj', 'y1')
                };
            }
            return [
                render(null, null),
                render({ x: 100, yTarget: null, yTank: 0, yWanted: NaN }, { xEnd: 200, yTarget: 0 }),
                render({ x: 100, yTarget: 0 }, { x0: 0, xEnd: 200, yTarget: 0 }),
                render({ x: 100, yTarget: 20 }, { x0: 0, xEnd: 200, yTarget: 0, xNow: 100, yNow: 0 })
            ];
        });
        expect(markers).toEqual([
            { heat: [], boiler: [], target: [], projection: [] },
            { heat: [], boiler: ['0'], target: [], projection: [] },
            { heat: [], boiler: ['0'], target: ['0'], projection: [] },
            { heat: [], boiler: ['20'], target: ['0'], projection: ['0'] }
        ]);
    } finally {
        assertErrors(errors, [], timing);
    }
});

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
