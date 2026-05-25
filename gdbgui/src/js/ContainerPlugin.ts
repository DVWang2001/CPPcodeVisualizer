// ContainerPlugin.ts
// Interface every container visualizer plugin must implement, plus the plugin registry.

import React from "react";
import { PluginOp } from "./AnimScheduler";

export interface ContainerData {
    type: string;
    values: unknown[];
    capacity?: number;
}

export interface ContainerPlugin {
    /** Container type strings this plugin handles, e.g. ['set','map','multiset','multimap']. */
    readonly supportedTypes: string[];

    /**
     * Diff new container data against the plugin's internal history.
     * Returns ops that should be animated. Plugin is responsible for updating
     * its own history state before returning.
     */
    diffOps(containerName: string, newData: ContainerData): PluginOp[];

    /**
     * Animate one op. Called sequentially by AnimScheduler — never concurrently
     * for the same container. Call requestRender() after mutating internal animation
     * state to trigger a re-render of ContainerVisualizer.
     */
    animateOp(containerName: string, op: PluginOp, requestRender: () => void): Promise<void>;

    /**
     * Run a prospective (pre-execution) animation — triggered by detect_container_op
     * BEFORE the container state changes (e.g. find/count/dup-insert).
     * Returns a Promise that resolves when the animation completes,
     * or null if this plugin does not handle this opType / container.
     * The caller (AnimScheduler / VisualizerHelper) is responsible for managing
     * the barrier around this promise.
     */
    prospectiveOp(
        containerName: string,
        opType: string,
        key: string,
        requestRender: () => void
    ): Promise<void> | null;

    /** Render the current visual state of a named container. */
    render(containerName: string): React.ReactNode;

    /** Reset ALL state — called on program restart. */
    resetAll(): void;

    /** Reset state for one container that went out of scope. */
    resetContainer(containerName: string): void;
}

// ── Plugin Registry ───────────────────────────────────────────────────────────

const _plugins = new Map<string, ContainerPlugin>();

export function registerPlugin(plugin: ContainerPlugin): void {
    for (const t of plugin.supportedTypes) {
        _plugins.set(t, plugin);
    }
}

export function getPlugin(containerType: string): ContainerPlugin | undefined {
    return _plugins.get(containerType);
}

/** All unique plugin instances (each plugin may support multiple types). */
export function allPlugins(): ContainerPlugin[] {
    return Array.from(new Set(_plugins.values()));
}
