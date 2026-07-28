// AnimScheduler.ts
// Single owner of the gdbgui_bst_anim_done barrier and per-container animation queues.
// Guarantees that at most one animation runs per container at a time.

export interface PluginOp {
    type: string;
    payload: unknown;
}

type AnimateFn = (op: PluginOp) => Promise<void>;

export class AnimScheduler {
    private readonly queues  = new Map<string, PluginOp[]>();
    private readonly running = new Set<string>();
    private barrierResolve: (() => void) | null = null;
    // true when the barrier was reserved by a prospective op (find/dup), not by a queue drain
    private prospectiveBarrier = false;

    // ── Queued ops (insert / erase) ───────────────────────────────────────────

    pushOps(containerName: string, ops: PluginOp[], animateFn: AnimateFn): void {
        if (ops.length === 0) return;
        const q = this.queues.get(containerName) ?? [];
        q.push(...ops);
        this.queues.set(containerName, q);
        if (!this.running.has(containerName)) {
            this._ensureBarrier(false);
            this._drain(containerName, animateFn);
        }
    }

    private async _drain(containerName: string, animateFn: AnimateFn): Promise<void> {
        this.running.add(containerName);
        const q = this.queues.get(containerName)!;
        while (q.length > 0) {
            const op = q.shift()!;
            await animateFn(op);
        }
        this.running.delete(containerName);
        this.queues.delete(containerName);
        // Resolve barrier only when no container is animating and no prospective op is pending
        if (this.running.size === 0 && !this.prospectiveBarrier) {
            this._resolveBarrier();
        }
    }

    // ── Prospective barrier (find / count / dup-insert) ───────────────────────
    // Must be called synchronously in inferior_program_paused (before TTS fires).

    /**
     * Reserve the barrier for a prospective animation.
     * Returns false only if another prospective op already owns it.
     *
     * A barrier held by a queue drain is JOINED rather than refused. The
     * container poll runs on its own 1s timer, so it can push insert/erase ops
     * and take the barrier moments before the next pause runs
     * detect_container_op. Refusing there meant the find / lower_bound
     * animation was silently skipped whenever those two happened to collide.
     * Joining marks the existing barrier prospective, which stops _drain from
     * resolving it when the queue empties, so the prospective animation still
     * gets its turn.
     */
    reserveBarrier(): boolean {
        if ((window as any).gdbgui_bst_anim_done) {
            if (this.prospectiveBarrier) return false; // another prospective op owns it
            this.prospectiveBarrier = true;
            return true;
        }
        this._ensureBarrier(true);
        return true;
    }

    /** Release the prospective barrier after animation completes or is aborted. */
    releaseBarrier(): void {
        if (this.prospectiveBarrier) {
            this.prospectiveBarrier = false;
            // A queue drain may still be in flight (we joined its barrier, or it
            // started while we ran). Leave the barrier to its completion,
            // otherwise TTS could advance mid-animation.
            if (this.running.size === 0) {
                this._resolveBarrier();
            }
        }
    }

    // ── Shared ────────────────────────────────────────────────────────────────

    isRunning(containerName: string): boolean {
        return this.running.has(containerName);
    }

    isBarrierActive(): boolean {
        return (window as any).gdbgui_bst_anim_done != null;
    }

    resetAll(): void {
        this.queues.clear();
        this.running.clear();
        this._resolveBarrier();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private _ensureBarrier(isProspective: boolean): void {
        if (!(window as any).gdbgui_bst_anim_done) {
            (window as any).gdbgui_bst_anim_done = new Promise<void>(resolve => {
                this.barrierResolve = resolve;
            });
            this.prospectiveBarrier = isProspective;
        }
    }

    private _resolveBarrier(): void {
        if (this.barrierResolve) {
            this.barrierResolve();
            this.barrierResolve = null;
        }
        (window as any).gdbgui_bst_anim_done = null;
        this.prospectiveBarrier = false;
    }
}

export const animScheduler = new AnimScheduler();
