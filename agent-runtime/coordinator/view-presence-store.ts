export interface ManagedViewPresence {
    viewId: string;
    projectId: string;
    viewRevision: number;
    connectedAt: string;
    heartbeatAt: string;
    followPresenter: boolean;
    selectedIds: readonly string[];
    playheadSample?: number;
    viewport?: Readonly<Record<string, number>>;
}

/**
 * Per-view state is intentionally memory-only. It never increments sessionRevision and vanishes
 * on coordinator restart, unlike durable presenter/playback authority in the project envelope.
 */
export class ViewPresenceStore {
    private readonly views = new Map<string, ManagedViewPresence>();

    attach(projectId: string, viewId: string): ManagedViewPresence {
        const now = new Date().toISOString();
        const presence: ManagedViewPresence = {
            viewId,
            projectId,
            viewRevision: 0,
            connectedAt: now,
            heartbeatAt: now,
            followPresenter: false,
            selectedIds: [],
        };
        this.views.set(viewId, presence);
        return presence;
    }

    update(
        viewId: string,
        update: Partial<Omit<ManagedViewPresence, 'viewId' | 'projectId' | 'connectedAt'>>,
    ): ManagedViewPresence {
        const current = this.views.get(viewId);
        if (!current) throw new Error('Managed view is not attached.');
        const next: ManagedViewPresence = {
            ...current,
            ...update,
            viewRevision: current.viewRevision + 1,
            heartbeatAt: new Date().toISOString(),
            selectedIds: update.selectedIds ? [...update.selectedIds] : current.selectedIds,
        };
        this.views.set(viewId, next);
        return next;
    }

    detach(viewId: string): void {
        this.views.delete(viewId);
    }

    list(projectId: string): ManagedViewPresence[] {
        return Array.from(this.views.values()).filter((view) => view.projectId === projectId);
    }

    expire(maximumIdleMilliseconds: number, now = Date.now()): string[] {
        const expired: string[] = [];
        for (const [viewId, view] of Array.from(this.views.entries())) {
            if (Date.parse(view.heartbeatAt) + maximumIdleMilliseconds <= now) {
                this.views.delete(viewId);
                expired.push(viewId);
            }
        }
        return expired;
    }
}
