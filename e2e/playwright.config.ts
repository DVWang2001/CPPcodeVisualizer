import { defineConfig } from '@playwright/test';

export default defineConfig({
    // 開跑前先確認容器是從目前工作區建出來的，見 global-setup.ts
    globalSetup: require.resolve('./global-setup'),
    testDir: './tests',
    timeout: 60_000,
    use: {
        baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://app:5000',
        headless: true,
        viewport: { width: 1280, height: 800 },
        trace: 'on',
        actionTimeout: 10_000,
    },
    workers: 1,   // serial — all specs share one GDB session
});
