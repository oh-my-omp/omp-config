import { dlopen, FFIType, type Library, ptr } from "bun:ffi";
import type { ProcessRecord, ProcessSource, SnapshotResult } from "./tracker.ts";

const PROC_PIDTBSDINFO = 3;
const BSD_INFO_SIZE = 136;
const BSD_STATUS = 4;
const BSD_PID = 12;
const BSD_PPID = 16;
const BSD_PGID = 100;
const BSD_START_SEC = 120;
const BSD_START_USEC = 128;
const SZOMB = 5;
const RUSAGE_INFO_V0 = 0;
const RUSAGE_SIZE = 96;
const RUSAGE_PHYS_FOOTPRINT = 72;
const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const ARGC_BYTES = 4;
const PATH_BYTES = 4096;
const MAX_COMMAND_CHARS = 240;
const MAX_ARGUMENT_BYTES = MAX_COMMAND_CHARS * 4;
const U32_RANGE = 2 ** 32;
const decoder = new TextDecoder();

const LIBPROC_ABI = {
	proc_listallpids: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
	proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
} as const;

type NativeSymbols = Library<typeof LIBPROC_ABI>["symbols"];

function readU64(view: DataView, offset: number): number {
	return view.getUint32(offset + 4, true) * U32_RANGE + view.getUint32(offset, true);
}

function sameProcess(a: ProcessRecord, b: ProcessRecord): boolean {
	return a.parentPid === b.parentPid && a.groupId === b.groupId && a.startedAt === b.startedAt;
}

function truncate(text: string): string {
	return text.length > MAX_COMMAND_CHARS ? `${text.slice(0, MAX_COMMAND_CHARS - 1)}…` : text;
}

function argumentBuffer(symbols: NativeSymbols): Uint8Array | null {
	const mib = new Int32Array([CTL_KERN, KERN_ARGMAX]);
	const value = new Int32Array(1);
	const length = new BigUint64Array([4n]);
	if (symbols.sysctl(ptr(mib), mib.length, ptr(value), ptr(length), null, 0) !== 0 || length[0] !== 4n) return null;
	const capacity = value[0];
	return capacity !== undefined && capacity > 0 ? new Uint8Array(capacity + ARGC_BYTES) : null;
}

/** Never decode the environment. */
function decodeCommand(bytes: Uint8Array, length: number): string | null {
	if (length < ARGC_BYTES) return null;
	const argc = new DataView(bytes.buffer, bytes.byteOffset, length).getInt32(0, true);
	if (argc <= 0 || argc > length - ARGC_BYTES) return null;
	let cursor = bytes.indexOf(0, ARGC_BYTES);
	if (cursor < 0 || cursor >= length) return null;
	while (cursor < length && bytes[cursor] === 0) cursor++;
	const args: string[] = [];
	let characters = 0;
	for (let index = 0; index < argc && cursor < length && characters < MAX_COMMAND_CHARS; index++) {
		const end = bytes.indexOf(0, cursor);
		if (end < cursor || end >= length) return null;
		const argument = decoder.decode(bytes.subarray(cursor, Math.min(end, cursor + MAX_ARGUMENT_BYTES))).replace(/\p{Cc}/gu, " ");
		args.push(argument);
		characters += argument.length + 1;
		cursor = end + 1;
	}
	const command = args.join(" ");
	return command.length === 0 ? null : truncate(command);
}

export class DarwinProcesses implements ProcessSource {
	readonly #library = dlopen("/usr/lib/libproc.dylib", LIBPROC_ABI);
	readonly #symbols = this.#library.symbols;
	readonly #info = new Uint8Array(BSD_INFO_SIZE);
	readonly #infoView = new DataView(this.#info.buffer);
	readonly #usage = new Uint8Array(RUSAGE_SIZE);
	readonly #usageView = new DataView(this.#usage.buffer);
	readonly #path = new Uint8Array(PATH_BYTES);
	readonly #args = argumentBuffer(this.#symbols);
	readonly #argsLength = new BigUint64Array(1);
	readonly #argsMib = new Int32Array([CTL_KERN, KERN_PROCARGS2, 0]);
	#pidBuffer = new Int32Array(1024);

	snapshot(): SnapshotResult {
		const symbols = this.#symbols;
		const needed = symbols.proc_listallpids(null, 0);
		if (needed <= 0) return { kind: "unavailable", reason: "proc_listallpids sizing failed" };
		if (needed >= this.#pidBuffer.length) this.#pidBuffer = new Int32Array(needed + 256);
		let count = symbols.proc_listallpids(ptr(this.#pidBuffer), this.#pidBuffer.byteLength);
		// A full buffer is not a complete snapshot: the kernel can add PIDs between sizing and filling.
		while (count >= this.#pidBuffer.length) {
			this.#pidBuffer = new Int32Array(this.#pidBuffer.length * 2);
			count = symbols.proc_listallpids(ptr(this.#pidBuffer), this.#pidBuffer.byteLength);
		}
		if (count <= 0) return { kind: "unavailable", reason: "proc_listallpids enumeration failed" };
		const pids = new Set<number>();
		for (const pid of this.#pidBuffer.subarray(0, count)) if (pid > 0) pids.add(pid);
		const processes = new Map<number, ProcessRecord>();
		for (const pid of pids) {
			const record = this.process(pid);
			if (record !== null) processes.set(pid, record);
		}
		// A reused PID or changed PPID/PGID must never authorize an ownership edge:
		// keep only records that stayed unchanged until every relation was read.
		for (const [pid, record] of processes) {
			const again = this.process(pid);
			if (again === null || !sameProcess(record, again)) processes.delete(pid);
		}
		return { kind: "available", snapshot: { processes, pids } };
	}

	process(pid: number): ProcessRecord | null {
		const view = this.#infoView;
		if (this.#symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(this.#info), BSD_INFO_SIZE) !== BSD_INFO_SIZE) return null;
		if (view.getUint32(BSD_PID, true) !== pid || view.getUint32(BSD_STATUS, true) === SZOMB) return null;
		return {
			pid,
			parentPid: view.getUint32(BSD_PPID, true),
			groupId: view.getUint32(BSD_PGID, true),
			startedAt: readU64(view, BSD_START_SEC) * 1_000_000 + readU64(view, BSD_START_USEC),
		};
	}

	footprint(pid: number): number | null {
		if (this.#symbols.proc_pid_rusage(pid, RUSAGE_INFO_V0, ptr(this.#usage)) !== 0) return null;
		return readU64(this.#usageView, RUSAGE_PHYS_FOOTPRINT);
	}

	command(pid: number): string {
		return this.#argv(pid) ?? this.#executablePath(pid) ?? "(command unavailable)";
	}

	close(): void {
		this.#library.close();
	}

	#argv(pid: number): string | null {
		const args = this.#args;
		if (args === null) return null;
		const before = this.process(pid);
		if (before === null) return null;
		this.#argsMib[2] = pid;
		this.#argsLength[0] = BigInt(args.byteLength);
		try {
			if (this.#symbols.sysctl(ptr(this.#argsMib), this.#argsMib.length, ptr(args), ptr(this.#argsLength), null, 0) !== 0) return null;
			const length = Number(this.#argsLength[0]);
			const after = this.process(pid);
			// A recycled PID's argv must never be decoded.
			if (length > args.byteLength || after === null || !sameProcess(before, after)) return null;
			return decodeCommand(args, length);
		} finally {
			// sysctl also copies environment bytes: never retain them or the full argv.
			args.fill(0);
		}
	}

	#executablePath(pid: number): string | null {
		const length = this.#symbols.proc_pidpath(pid, ptr(this.#path), this.#path.byteLength);
		return length > 0 ? truncate(decoder.decode(this.#path.subarray(0, length))) : null;
	}
}
