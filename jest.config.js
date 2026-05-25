module.exports = {
    preset: 'ts-jest',
    verbose: true,
    testEnvironment: 'jsdom',
    setupFiles: ['<rootDir>/gdbgui/src/js/tests/setup.ts'],
    // Only run files named *.jest.ts / *.jest.js — avoids treating setup.ts as a suite
    testMatch: ['<rootDir>/gdbgui/src/js/tests/**/*.jest.{ts,js}'],
    transform: {
        '^.+\\.(j|t)sx?$': 'ts-jest'
    },
    globals: {
        'ts-jest': {
            // Override module to commonjs so Jest can resolve ES-module imports
            tsConfig: { module: 'commonjs' }
        }
    }
};
