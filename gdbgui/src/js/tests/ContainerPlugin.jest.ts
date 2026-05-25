// ContainerPlugin.jest.ts
// Tests for the plugin registry (registerPlugin / getPlugin / allPlugins).
// The registry is module-level state shared within this file, so tests are
// written additively inside nested describe blocks using beforeAll.

import { registerPlugin, getPlugin, allPlugins } from '../ContainerPlugin';
import type { ContainerPlugin } from '../ContainerPlugin';

function makePlugin(types: string[]): ContainerPlugin {
    return {
        supportedTypes: types,
        diffOps: jest.fn().mockReturnValue([]),
        animateOp: jest.fn().mockResolvedValue(undefined),
        prospectiveOp: jest.fn().mockReturnValue(null),
        render: jest.fn().mockReturnValue(null),
        resetAll: jest.fn(),
        resetContainer: jest.fn(),
    };
}

describe('ContainerPlugin registry', () => {

    // ── Initial state ──────────────────────────────────────────────────────────

    describe('before any plugins are registered', () => {
        it('getPlugin returns undefined for any type', () => {
            expect(getPlugin('set')).toBeUndefined();
            expect(getPlugin('vector')).toBeUndefined();
            expect(getPlugin('anything')).toBeUndefined();
        });

        it('allPlugins returns an empty array', () => {
            expect(allPlugins()).toEqual([]);
        });
    });

    // ── Single plugin covering multiple types ──────────────────────────────────

    describe('after registering a plugin for [set, multiset]', () => {
        const setPlugin = makePlugin(['set', 'multiset']);

        beforeAll(() => { registerPlugin(setPlugin); });

        it('getPlugin("set") returns the registered plugin', () => {
            expect(getPlugin('set')).toBe(setPlugin);
        });

        it('getPlugin("multiset") returns the same plugin instance', () => {
            expect(getPlugin('multiset')).toBe(setPlugin);
        });

        it('getPlugin for an unregistered type is still undefined', () => {
            expect(getPlugin('vector')).toBeUndefined();
        });

        it('allPlugins contains the plugin exactly once (no duplicates per type)', () => {
            const all = allPlugins();
            expect(all).toContain(setPlugin);
            // Even though set + multiset both map to setPlugin, it should appear once
            expect(all.filter(p => p === setPlugin)).toHaveLength(1);
        });
    });

    // ── Second plugin ──────────────────────────────────────────────────────────

    describe('after also registering a plugin for [map, multimap]', () => {
        const mapPlugin = makePlugin(['map', 'multimap']);

        beforeAll(() => { registerPlugin(mapPlugin); });

        it('getPlugin("map") returns mapPlugin', () => {
            expect(getPlugin('map')).toBe(mapPlugin);
        });

        it('getPlugin("multimap") returns mapPlugin', () => {
            expect(getPlugin('multimap')).toBe(mapPlugin);
        });

        it('getPlugin("set") still returns the set plugin', () => {
            expect(getPlugin('set')).not.toBe(mapPlugin);
        });

        it('allPlugins contains both plugins, each exactly once', () => {
            const all = allPlugins();
            // Two distinct instances
            expect(all.filter(p => p.supportedTypes.includes('set'))).toHaveLength(1);
            expect(all.filter(p => p.supportedTypes.includes('map'))).toHaveLength(1);
            expect(all.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ── Overwrite ──────────────────────────────────────────────────────────────

    describe('registerPlugin overwrites an existing type mapping', () => {
        it('a new plugin registered for "set" replaces the previous one', () => {
            const oldPlugin = getPlugin('set');
            const newPlugin = makePlugin(['set']);
            registerPlugin(newPlugin);
            expect(getPlugin('set')).toBe(newPlugin);
            expect(getPlugin('set')).not.toBe(oldPlugin);
        });
    });
});
