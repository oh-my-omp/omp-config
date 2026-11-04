/** Kernel identities and live ancestry/group ownership; no IO or session state. */
interface ProcessIdentity {
	readonly pid: number;
	readonly startedAt: bigint;
}

export interface ProcessRecord extends ProcessIdentity {
	readonly parentPid: number;
	readonly groupId: number;
}

interface ProcessSnapshot {
	/** Two-pass verified non-zombie rows only; an enumerated PID alone is not a live anchor. */
	readonly processes: ReadonlyMap<number, ProcessRecord>;
	/** Includes PIDs whose BSD info was unavailable; absence alone proves exit. */
	readonly pids: ReadonlySet<number>;
}

export type SnapshotResult = { kind: "available"; snapshot: ProcessSnapshot } | { kind: "unavailable"; reason: string };

export interface ProcessSource {
	snapshot(): SnapshotResult;
	process(pid: number): ProcessRecord | null;
	footprint(pid: number): bigint | null;
	command(pid: number): string;
	close(): void;
}

interface TrackedProcess {
	readonly identity: ProcessIdentity;
	alerted: boolean;
}

export class ProcessTracker {
	readonly #root: ProcessIdentity;
	readonly #owned = new Map<number, TrackedProcess>();
	/** A generation is established only by observing its owned group leader. */
	readonly #groups = new Map<number, bigint>();

	constructor(root: ProcessIdentity) {
		this.#root = root;
	}

	observe(snapshot: ProcessSnapshot): readonly TrackedProcess[] {
		const { processes, pids } = snapshot;
		for (const [pid, tracked] of this.#owned) {
			const current = processes.get(pid);
			if (!pids.has(pid) || (current !== undefined && current.startedAt !== tracked.identity.startedAt)) this.#owned.delete(pid);
		}
		const children = new Map<number, ProcessRecord[]>();
		const members = new Map<number, ProcessRecord[]>();
		for (const current of processes.values()) {
			const parent = processes.get(current.parentPid);
			if (parent !== undefined && parent.startedAt <= current.startedAt) {
				const siblings = children.get(parent.pid);
				if (siblings === undefined) children.set(parent.pid, [current]);
				else siblings.push(current);
			}
			const group = members.get(current.groupId);
			if (group === undefined) members.set(current.groupId, [current]);
			else group.push(current);
		}

		const queue: ProcessRecord[] = [];
		const seen = new Set<number>();
		const anchored = new Set<number>();
		const enqueue = (current: ProcessRecord): void => {
			if (seen.has(current.pid)) return;
			seen.add(current.pid);
			queue.push(current);
		};
		const root = processes.get(this.#root.pid);
		if (root?.startedAt === this.#root.startedAt) enqueue(root);
		for (const tracked of this.#owned.values()) {
			const current = processes.get(tracked.identity.pid);
			if (current?.startedAt === tracked.identity.startedAt) enqueue(current);
		}
		for (let index = 0; index < queue.length; index++) {
			const current = queue[index];
			if (current === undefined) break;
			if (current.pid !== this.#root.pid) {
				if (!this.#owned.has(current.pid)) this.#owned.set(current.pid, { identity: current, alerted: false });
				if (current.pid === current.groupId) this.#groups.set(current.groupId, current.startedAt);
				const generation = this.#groups.get(current.groupId);
				const leader = processes.get(current.groupId);
				if (
					generation !== undefined &&
					!anchored.has(current.groupId) &&
					(leader?.startedAt === generation || !pids.has(current.groupId))
				) {
					anchored.add(current.groupId);
					for (const member of members.get(current.groupId) ?? []) if (member.startedAt >= generation) enqueue(member);
				}
			}
			for (const child of children.get(current.pid) ?? []) enqueue(child);
		}
		// A bare PGID is not durable identity: never let an empty old group claim a reused number.
		for (const groupId of this.#groups.keys()) if (!anchored.has(groupId)) this.#groups.delete(groupId);
		return [...this.#owned.values()].filter((tracked) => processes.get(tracked.identity.pid)?.startedAt === tracked.identity.startedAt);
	}
}
