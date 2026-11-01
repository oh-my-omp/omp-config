// Records the scan worker returns. Shared by worker.ts (no host imports) and the main thread.

/** One subagent transcript's dispatch facts, as the worker read them. */
export type DispatchRecord = {
	readonly agent: string;
	/** `session_init.resolvedModel`, e.g. `openai-codex/gpt-5.6-sol:high`; empty when absent. */
	readonly resolvedModel: string;
	/** Every `provider/model` an assistant message ran on. */
	readonly models: readonly string[];
	/** A `model_change` recorded `resolvedModelIsFallback`. */
	readonly fallback: boolean;
	/** The transcript wrote `session_exit`. */
	readonly exited: boolean;
	readonly mtimeMs: number;
	/** USD of assistant and `model_usage` entries, per provider. */
	readonly costByProvider: Readonly<Record<string, number>>;
};

/** A dispatch with the transcript it came from, as the scan returns it. */
export type ScannedDispatch = DispatchRecord & { readonly file: string };

export type ScanRequest = { readonly sessionsRoot: string; readonly cachePath: string };

export type ScanResult =
	| {
			readonly kind: "done";
			/** `provider/model` -> hour index (epoch ms / 3_600_000) -> USD, from event timestamps. */
			readonly spend: Readonly<Record<string, Readonly<Record<string, number>>>>;
			readonly dispatches: readonly ScannedDispatch[];
			readonly files: number;
			/** Transcripts parsed this run; the rest came from the per-file cache. */
			readonly parsed: number;
	  }
	| { readonly kind: "failed"; readonly reason: string };
