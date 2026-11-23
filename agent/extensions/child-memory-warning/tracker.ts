interface ProcessIdentity {
	readonly pid: number;
	readonly startedAt: number;
}

export interface ProcessRecord extends ProcessIdentity {
	readonly parentPid: number;
	readonly groupId: number;
}

interface ProcessSnapshot {
	readonly processes: ReadonlyMap<number, ProcessRecord>;
	readonly pids: ReadonlySet<number>;
}

export type SnapshotResult = { kind: "available"; snapshot: ProcessSnapshot } | { kind: "unavailable"; reason: string };

export interface ProcessSource {
	snapshot(): SnapshotResult;
	process(pid: number): ProcessRecord | null;
	footprint(pid: number): number | null;
	command(pid: number): string;
	close(): void;
}

interface TrackedProcess {
	readonly identity: ProcessIdentity;
	alerted: boolean;
}

interface ProcessIndex {
	readonly children: ReadonlyMap<number, readonly ProcessRecord[]>;
	readonly members: ReadonlyMap<number, readonly ProcessRecord[]>;
}

function append(map: Map<number, ProcessRecord[]>, key: number, record: ProcessRecord): void {
	const list = map.get(key);
	if (list === undefined) map.set(key, [record]);
	else list.push(record);
}

function indexProcesses(processes: ReadonlyMap<number, ProcessRecord>): ProcessIndex {
	const children = new Map<number, ProcessRecord[]>();
	const members = new Map<number, ProcessRecord[]>();
	for (const current of processes.values()) {
		const parent = processes.get(current.parentPid);
		if (parent !== undefined && parent.startedAt <= current.startedAt) append(children, parent.pid, current);
		append(members, current.groupId, current);
	}
	return { children, members };
}

function liveRecord(processes: ReadonlyMap<number, ProcessRecord>, identity: ProcessIdentity): ProcessRecord | undefined {
	const current = processes.get(identity.pid);
	return current?.startedAt === identity.startedAt ? current : undefined;
}

export class ProcessTracker {
	readonly #root: ProcessIdentity;
	readonly #owned = new Map<number, TrackedProcess>();
	readonly #groups = new Map<number, number>();

	constructor(root: ProcessIdentity) {
		this.#root = root;
	}

	observe(snapshot: ProcessSnapshot): TrackedProcess[] {
		this.#prune(snapshot);
		this.#walk(snapshot, indexProcesses(snapshot.processes));
		return [...this.#owned.values()].filter((tracked) => liveRecord(snapshot.processes, tracked.identity) !== undefined);
	}

	#prune({ processes, pids }: ProcessSnapshot): void {
		for (const [pid, tracked] of this.#owned) {
			const current = processes.get(pid);
			if (!pids.has(pid) || (current !== undefined && current.startedAt !== tracked.identity.startedAt)) this.#owned.delete(pid);
		}
	}

	#walk({ processes, pids }: ProcessSnapshot, { children, members }: ProcessIndex): void {
		const queue: ProcessRecord[] = [];
		const seen = new Set<number>();
		const anchored = new Set<number>();
		const enqueue = (current: ProcessRecord | undefined): void => {
			if (current === undefined || seen.has(current.pid)) return;
			seen.add(current.pid);
			queue.push(current);
		};
		enqueue(liveRecord(processes, this.#root));
		for (const tracked of this.#owned.values()) enqueue(liveRecord(processes, tracked.identity));
		for (const current of queue) {
			if (current.pid !== this.#root.pid) {
				if (!this.#owned.has(current.pid)) this.#owned.set(current.pid, { identity: current, alerted: false });
				if (current.pid === current.groupId) this.#groups.set(current.groupId, current.startedAt);
				const generation = this.#groups.get(current.groupId);
				if (
					generation !== undefined &&
					!anchored.has(current.groupId) &&
					(processes.get(current.groupId)?.startedAt === generation || !pids.has(current.groupId))
				) {
					anchored.add(current.groupId);
					for (const member of members.get(current.groupId) ?? []) if (member.startedAt >= generation) enqueue(member);
				}
			}
			for (const child of children.get(current.pid) ?? []) enqueue(child);
		}
		// A bare PGID is not durable identity: never let an empty old group claim a reused number.
		for (const groupId of this.#groups.keys()) if (!anchored.has(groupId)) this.#groups.delete(groupId);
	}
}
