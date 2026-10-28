// Streaming, projecting JSONL scanner for OMP session files.
// A byte-level JSON tokenizer walks every record without materializing it:
// a Policy tree decides which values are built, and strings are captured up
// to a per-position cap while their full UTF-16 length and line count are
// still measured. Skipped strings are crossed with native indexOf, so a record
// of hundreds of MB costs one pass over its bytes and no allocation for it.
// Validation is JSON.parse-equivalent for every built or measured value; inside
// skipped strings only the record-ending newline is checked (other raw control
// bytes there are tolerated). Host-free (Bun/Web APIs only).

/** A string longer than its cap: the captured prefix plus the full measure. */
export class Clipped {
	constructor(
		readonly text: string,
		readonly chars: number,
		readonly lines: number,
	) {}
}

export type Projected = string | number | boolean | null | Clipped | ProjectedObject | Projected[];
export interface ProjectedObject {
	[key: string]: Projected;
}

/** What to build at one value position. `cap` bounds captured string length (0 = measure only). */
export type Policy =
	| { readonly kind: "skip" }
	| { readonly kind: "keep"; readonly cap: number; readonly maxItems: number; readonly child: (key: string | number) => Policy };

export const SKIP: Policy = { kind: "skip" };

/** Keeps a whole subtree: strings capped at `cap`, containers at `maxItems` children. */
export function keepAll(cap: number, maxItems: number): Policy {
	const policy: Policy = { kind: "keep", cap, maxItems, child: () => policy };
	return policy;
}

/** Keeps the listed keys of an object (strings directly under it capped at `cap`). */
export function keys(table: Readonly<Record<string, Policy>>): Policy {
	return {
		kind: "keep",
		cap: 0,
		maxItems: Number.POSITIVE_INFINITY,
		child: (key) => (typeof key === "string" && Object.hasOwn(table, key) ? (table[key] ?? SKIP) : SKIP),
	};
}

/** Keeps an array (or a string measured only) whose every element follows `element`. */
export function each(element: Policy, maxItems = Number.POSITIVE_INFINITY): Policy {
	return { kind: "keep", cap: 0, maxItems, child: () => element };
}

/** Keeps a scalar; a string is captured up to `cap` characters. */
export function scalar(cap: number): Policy {
	return { kind: "keep", cap, maxItems: 0, child: () => SKIP };
}

/** One complete line's top-level value, projected. */
export interface ScannedRecord {
	readonly line: number;
	readonly value: Projected;
}

export interface ScanStats {
	readonly records: number;
	/** Physical line numbers of complete lines that failed to parse. */
	readonly invalidLines: readonly number[];
	/** Line number of an unterminated, incomplete final record (a writer mid-append), if any. */
	readonly incompleteTail: number | null;
	readonly bytes: number;
}

/** An object without a prototype, so a `__proto__` key is an ordinary own key, as in JSON.parse. */
function newObject(): ProjectedObject {
	return Object.create(null) as ProjectedObject; // null-prototype record: no runtime check exists for "has no inherited keys"
}

type Mode =
	| "value"
	| "objectKeyOrEnd"
	| "objectKey"
	| "colon"
	| "objectCommaOrEnd"
	| "arrayValueOrEnd"
	| "arrayCommaOrEnd"
	| "string"
	| "literal"
	| "afterTop"
	| "skipLine";

interface Frame {
	readonly array: boolean;
	readonly policy: Policy;
	readonly target: ProjectedObject | Projected[] | null;
	key: string;
	count: number;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;
const HEX = /^[0-9a-fA-F]{4}$/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const SIMPLE_ESCAPES: Readonly<Record<number, string>> = {
	[QUOTE]: '"',
	[BACKSLASH]: "\\",
	47: "/",
	98: "\b",
	102: "\f",
	110: "\n",
	114: "\r",
	116: "\t",
};
const DECODE_FLUSH_BYTES = 64 * 1024;
const MAX_LITERAL = 512;
const KEY_POLICY: Policy = scalar(Number.POSITIVE_INFINITY);

class ParseError extends Error {}

/**
 * Incremental tokenizer. Feed chunks with `push`, finish with `end`.
 * Each complete line that parses yields one record (its top-level value projected).
 */
class JsonlScanner {
	readonly #root: (line: number) => Policy;
	readonly #emit: (record: ScannedRecord) => void;
	#mode: Mode = "value";
	#stack: Frame[] = [];
	#line = 1;
	#recordStarted = false;
	#records = 0;
	#bytes = 0;
	readonly #invalid: number[] = [];
	#topValue: Projected | undefined;
	#topSet = false;
	#stringIsKey = false;
	#stringCap = 0;
	#stringCapture = false;
	#stringMeasure = false;
	#stringChars = 0;
	#stringNewlines = 0;
	#stringParts: string[] = [];
	#stringStored = 0;
	#stringDecoder: TextDecoder | null = null;
	#stringPending: Uint8Array[] = [];
	#stringPendingBytes = 0;
	#escape = 0; // 0 none, 1 after backslash, 2 collecting \u hex digits
	#hex = "";
	#literal = "";
	#literalPolicy: Policy = SKIP;
	/** Per chunk: next index of `"`, `\` and newline at or after the last lookup (-1 none left, -2 unknown). */
	readonly #next: [number, number, number] = [-2, -2, -2];

	constructor(root: (line: number) => Policy, emit: (record: ScannedRecord) => void) {
		this.#root = root;
		this.#emit = emit;
	}

	push(chunk: Uint8Array): void {
		this.#bytes += chunk.length;
		this.#next.fill(-2);
		let index = 0;
		while (index < chunk.length) {
			if (this.#mode === "skipLine") {
				const newline = this.#nextOf(2, NEWLINE, chunk, index);
				if (newline === -1) return;
				index = newline + 1;
				this.#line++;
				this.#reset();
				continue;
			}
			if (this.#mode === "string") {
				index = this.#stringRun(chunk, index);
				continue;
			}
			const byte = chunk[index] ?? 0;
			try {
				this.#byte(byte);
				index++;
			} catch (error) {
				if (!(error instanceof ParseError)) throw error;
				this.#fail();
				// Leave a newline unconsumed so skipLine ends the line there.
				if (byte !== NEWLINE) index++;
			}
		}
	}

	end(): ScanStats {
		let incompleteTail: number | null = null;
		if (this.#mode === "literal" && this.#stack.length === 0) {
			try {
				this.#endLiteral();
			} catch (error) {
				if (!(error instanceof ParseError)) throw error;
			}
		}
		if (this.#mode === "afterTop") this.#finishRecord();
		else if (this.#mode !== "skipLine" && this.#recordStarted) incompleteTail = this.#line;
		return { records: this.#records, invalidLines: [...this.#invalid], incompleteTail, bytes: this.#bytes };
	}

	#reset(): void {
		this.#mode = "value";
		this.#stack = [];
		this.#recordStarted = false;
		this.#topValue = undefined;
		this.#topSet = false;
		this.#escape = 0;
		this.#literal = "";
		this.#stringParts = [];
		this.#stringPending = [];
		this.#stringPendingBytes = 0;
		this.#stringDecoder = null;
	}

	/** Malformed line: count it and resynchronize at its newline. */
	#fail(): void {
		this.#invalid.push(this.#line);
		this.#mode = "skipLine";
	}

	#finishRecord(): void {
		if (this.#topSet && this.#topValue !== undefined) {
			this.#records++;
			this.#emit({ line: this.#line, value: this.#topValue });
		}
		this.#reset();
	}

	#currentPolicy(): Policy {
		const frame = this.#stack.at(-1);
		if (!frame) return this.#root(this.#line);
		if (frame.policy.kind === "skip" || frame.count >= frame.policy.maxItems) return SKIP;
		return frame.policy.child(frame.array ? frame.count : frame.key);
	}

	#attach(value: Projected | undefined): void {
		const frame = this.#stack.at(-1);
		if (!frame) {
			this.#topValue = value;
			this.#topSet = true;
			this.#mode = "afterTop";
			return;
		}
		if (frame.target !== null && value !== undefined) {
			if (Array.isArray(frame.target)) frame.target.push(value);
			else frame.target[frame.key] = value;
		}
		frame.count++;
		this.#mode = frame.array ? "arrayCommaOrEnd" : "objectCommaOrEnd";
	}

	#byte(byte: number): void {
		const whitespace = byte === 0x20 || byte === 0x09 || byte === 0x0d;
		if (byte === NEWLINE) {
			if (this.#mode === "literal") this.#endLiteral();
			if (this.#mode === "afterTop") this.#finishRecord();
			else if (this.#recordStarted) throw new ParseError("newline inside record");
			this.#line++;
			return;
		}
		switch (this.#mode) {
			case "literal":
				if (whitespace || byte === 0x2c || byte === 0x7d || byte === 0x5d) {
					this.#endLiteral();
					this.#byte(byte);
					return;
				}
				if (this.#literal.length >= MAX_LITERAL) throw new ParseError("literal too long");
				this.#literal += String.fromCharCode(byte);
				return;
			case "afterTop":
				if (!whitespace) throw new ParseError("trailing data");
				return;
			case "value":
			case "arrayValueOrEnd":
				if (whitespace) return;
				if (this.#mode === "arrayValueOrEnd" && byte === 0x5d) {
					this.#closeContainer(true);
					return;
				}
				this.#startValue(byte);
				return;
			case "objectKeyOrEnd":
			case "objectKey":
				if (whitespace) return;
				if (this.#mode === "objectKeyOrEnd" && byte === 0x7d) {
					this.#closeContainer(false);
					return;
				}
				if (byte !== QUOTE) throw new ParseError("expected key");
				this.#startString(true, KEY_POLICY);
				return;
			case "colon":
				if (whitespace) return;
				if (byte !== 0x3a) throw new ParseError("expected colon");
				this.#mode = "value";
				return;
			case "objectCommaOrEnd":
				if (whitespace) return;
				if (byte === 0x2c) this.#mode = "objectKey";
				else if (byte === 0x7d) this.#closeContainer(false);
				else throw new ParseError("expected , or }");
				return;
			case "arrayCommaOrEnd":
				if (whitespace) return;
				if (byte === 0x2c) this.#mode = "value";
				else if (byte === 0x5d) this.#closeContainer(true);
				else throw new ParseError("expected , or ]");
				return;
			case "string":
			case "skipLine":
				throw new Error(`scanner mode ${this.#mode} reached the structural byte path`);
			default: {
				const unreachable: never = this.#mode;
				throw new Error(`Unhandled scanner mode ${String(unreachable)}`);
			}
		}
	}

	#startValue(byte: number): void {
		this.#recordStarted = true;
		const policy = this.#currentPolicy();
		if (byte === 0x7b || byte === 0x5b) {
			const array = byte === 0x5b;
			const target = policy.kind === "keep" ? (array ? [] : newObject()) : null;
			this.#stack.push({ array, policy, target, key: "", count: 0 });
			this.#mode = array ? "arrayValueOrEnd" : "objectKeyOrEnd";
			return;
		}
		if (byte === QUOTE) {
			this.#startString(false, policy);
			return;
		}
		if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39) || byte === 0x74 || byte === 0x66 || byte === 0x6e) {
			this.#literal = String.fromCharCode(byte);
			this.#literalPolicy = policy;
			this.#mode = "literal";
			return;
		}
		throw new ParseError("unexpected value");
	}

	#endLiteral(): void {
		const text = this.#literal;
		this.#literal = "";
		let value: Projected;
		if (text === "true") value = true;
		else if (text === "false") value = false;
		else if (text === "null") value = null;
		else if (NUMBER.test(text)) value = Number(text);
		else throw new ParseError("bad literal");
		this.#attach(this.#literalPolicy.kind === "keep" ? value : undefined);
	}

	#closeContainer(array: boolean): void {
		const frame = this.#stack.pop();
		if (!frame || frame.array !== array) throw new ParseError("mismatched close");
		this.#attach(frame.target ?? undefined);
	}

	#startString(isKey: boolean, policy: Policy): void {
		this.#recordStarted = true;
		this.#mode = "string";
		this.#stringIsKey = isKey;
		this.#stringMeasure = policy.kind === "keep";
		this.#stringCap = policy.kind === "keep" ? policy.cap : 0;
		this.#stringCapture = this.#stringMeasure && this.#stringCap > 0;
		this.#stringChars = 0;
		this.#stringNewlines = 0;
		this.#stringParts = [];
		this.#stringStored = 0;
		// ignoreBOM keeps a leading U+FEFF: it is string content here, not a stream marker.
		this.#stringDecoder = this.#stringCapture ? new TextDecoder("utf-8", { ignoreBOM: true }) : null;
		this.#stringPending = [];
		this.#stringPendingBytes = 0;
		this.#escape = 0;
		this.#hex = "";
	}

	/**
	 * Index of the next `byte` in `chunk` at or after `from`, reusing the cached
	 * position while it is still ahead: each chunk is then searched once per byte
	 * kind in total instead of once per string run (escapes made that quadratic).
	 */
	#nextOf(slot: 0 | 1 | 2, byte: number, chunk: Uint8Array, from: number): number {
		const cached = this.#next[slot];
		if (cached === -1 || cached >= from) return cached;
		const found = chunk.indexOf(byte, from);
		this.#next[slot] = found;
		return found;
	}

	/** Consumes string bytes from `index`; returns the next unconsumed index. */
	#stringRun(chunk: Uint8Array, index: number): number {
		if (this.#escape !== 0) {
			const byte = chunk[index] ?? 0;
			if (byte === NEWLINE) {
				this.#fail();
				return index;
			}
			this.#escapeByte(byte);
			return index + 1;
		}
		const quote = this.#nextOf(0, QUOTE, chunk, index);
		const backslash = this.#nextOf(1, BACKSLASH, chunk, index);
		let stop = chunk.length;
		if (quote !== -1) stop = quote;
		if (backslash !== -1 && backslash < stop) stop = backslash;
		const newline = this.#nextOf(2, NEWLINE, chunk, index);
		if (newline !== -1 && newline < stop) {
			this.#fail();
			return newline;
		}
		if (stop > index && !this.#rawBytes(chunk, index, stop)) return stop;
		if (stop === chunk.length) return stop;
		if (stop === quote) {
			try {
				this.#endString();
			} catch (error) {
				if (!(error instanceof ParseError)) throw error;
				this.#fail();
			}
			return stop + 1;
		}
		this.#escape = 1;
		return stop + 1;
	}

	/** Measures (and captures) raw UTF-8 bytes; false when a control byte makes the line invalid. */
	#rawBytes(chunk: Uint8Array, from: number, to: number): boolean {
		if (!this.#stringMeasure) return true;
		let length = 0;
		for (let index = from; index < to; index++) {
			const byte = chunk[index] ?? 0;
			if (byte < 0x20) {
				this.#fail();
				return false;
			}
			// UTF-16 length: ASCII and 2/3-byte leads count 1, 4-byte leads 2, continuations 0.
			if (byte < 0x80 || (byte >= 0xc0 && byte < 0xf0)) length++;
			else if (byte >= 0xf0) length += 2;
		}
		this.#stringChars += length;
		if (!this.#stringCapture || this.#stringStored >= this.#stringCap) return true;
		const slice = chunk.slice(from, to);
		this.#stringPending.push(slice);
		this.#stringPendingBytes += slice.length;
		if (this.#stringPendingBytes >= DECODE_FLUSH_BYTES) this.#flushPending(true);
		return true;
	}

	#flushPending(stream: boolean): void {
		const decoder = this.#stringDecoder;
		if (!decoder) return;
		for (const part of this.#stringPending) this.#store(decoder.decode(part, { stream: true }));
		this.#stringPending = [];
		this.#stringPendingBytes = 0;
		if (!stream) this.#store(decoder.decode());
	}

	#store(text: string): void {
		if (!text || this.#stringStored >= this.#stringCap) return;
		this.#stringParts.push(text);
		this.#stringStored += text.length;
	}

	#appendChar(text: string): void {
		if (!this.#stringMeasure) return;
		this.#stringChars += 1;
		if (text === "\n") this.#stringNewlines++;
		if (!this.#stringCapture || this.#stringStored >= this.#stringCap) return;
		this.#flushPending(true);
		this.#store(text);
	}

	#escapeByte(byte: number): void {
		if (this.#escape === 2) {
			this.#hex += String.fromCharCode(byte);
			if (this.#hex.length < 4) return;
			if (!HEX.test(this.#hex)) {
				this.#fail();
				return;
			}
			this.#appendChar(String.fromCharCode(Number.parseInt(this.#hex, 16)));
			this.#escape = 0;
			return;
		}
		if (byte === 0x75) {
			this.#escape = 2;
			this.#hex = "";
			return;
		}
		const decoded = SIMPLE_ESCAPES[byte];
		if (decoded === undefined) {
			this.#fail();
			return;
		}
		this.#appendChar(decoded);
		this.#escape = 0;
	}

	#endString(): void {
		this.#flushPending(false);
		const text = this.#stringParts.join("");
		this.#stringParts = [];
		this.#stringDecoder = null;
		if (this.#stringIsKey) {
			const frame = this.#stack.at(-1);
			if (!frame || frame.array) throw new ParseError("key outside object");
			frame.key = text;
			this.#mode = "colon";
			return;
		}
		if (!this.#stringMeasure) {
			this.#attach(undefined);
			return;
		}
		const chars = this.#stringChars;
		this.#attach(
			chars <= this.#stringCap ? text : new Clipped(text.slice(0, this.#stringCap), chars, chars === 0 ? 0 : this.#stringNewlines + 1),
		);
	}
}

/**
 * Scans a JSONL byte stream (`Bun.file(path).stream()`, or any chunk sequence)
 * with `policy`, calling `onRecord` per parsed line. Chunk boundaries may fall
 * anywhere, including inside a UTF-8 character or an escape.
 */
export async function scanChunks(
	chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	policy: (line: number) => Policy,
	onRecord: (record: ScannedRecord) => void,
	signal?: AbortSignal,
): Promise<ScanStats> {
	const scanner = new JsonlScanner(policy, onRecord);
	for await (const chunk of chunks) {
		signal?.throwIfAborted();
		scanner.push(chunk);
	}
	return scanner.end();
}
