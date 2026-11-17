'use strict';

const { defineConfig } = require('@playwright/test');
const dashboardUrl = process.env.TEST_GX_UI_URL || 'http://127.0.0.1:1881/ui/';

module.exports = defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.js',
    fullyParallel: false,
    workers: 1,
    timeout: 120_000,
    reporter: 'list',
    use: {
        baseURL: dashboardUrl.endsWith('/') ? dashboardUrl : `${dashboardUrl}/`,
        browserName: 'chromium',
        channel: process.env.TEST_GX_UI_BROWSER || 'msedge',
        headless: true,
        viewport: { width: 1440, height: 1000 },
    },
});
