import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30_000,
    use: {
        baseURL: 'http://app:5000',
        headless: true,
        viewport: { width: 1280, height: 800 },
    },
    workers: 1,   // serial — all specs share one GDB session
});
