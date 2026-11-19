export type DispatchRecord = {
	readonly agent: string;
	readonly resolvedModel: string;
	readonly models: readonly string[];
	readonly fallback: boolean;
	readonly exited: boolean;
	readonly mtimeMs: number;
	readonly costByProvider: Readonly<Record<string, number>>;
};

export type ScannedDispatch = DispatchRecord & { readonly file: string };

export type ScanRequest = { readonly sessionsRoot: string; readonly cachePath: string };

export type ScanResult =
	| {
			readonly kind: "done";
			readonly spend: Readonly<Record<string, Readonly<Record<string, number>>>>;
			readonly dispatches: readonly ScannedDispatch[];
			readonly files: number;
			readonly parsed: number;
	  }
	| { readonly kind: "failed"; readonly reason: string };
