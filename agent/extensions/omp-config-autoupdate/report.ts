import type { ConflictReason } from "./merge.ts";

export interface ApplyOptions {
	readonly source: string;
	readonly agentDir: string;
	readonly previousCommit: string | undefined;
	readonly check: boolean;
	readonly plugins: boolean;
}

export type Conflict =
	| { readonly kind: "file"; readonly id: string; readonly rel: string; readonly target: string; readonly reason: ConflictReason }
	| {
			readonly kind: "key";
			readonly id: string;
			readonly rel: string;
			readonly target: string;
			readonly path: string[];
			readonly reason: ConflictReason;
	  };

export interface PluginChange {
	readonly spec: string;
	readonly name: string;
	readonly from: string | null;
	readonly to: string | null;
}

export interface PluginRefresh {
	readonly installed: string[];
	readonly upgraded: string[];
	readonly errors: string[];
	readonly changes: PluginChange[];
	readonly notes: string[];
}

export interface ApplyReport {
	readonly written: string[];
	readonly moved: { from: string; to: string }[];
	readonly deleted: string[];
	readonly skipped: { path: string; reason: string }[];
	readonly errors: string[];
	readonly notes: string[];
	readonly pluginsInstalled: string[];
	readonly pluginsUpgraded: string[];
	readonly pluginsMissing: string[];
	readonly pluginChanges: PluginChange[];
	readonly conflicts: Conflict[];
	readonly overwritten: string[];
	restartNeeded: boolean;
}

export type ConflictScan =
	| { readonly kind: "scanned"; readonly conflicts: Conflict[] }
	| { readonly kind: "failed"; readonly error: string };

export function newReport(): ApplyReport {
	return {
		written: [],
		moved: [],
		deleted: [],
		skipped: [],
		errors: [],
		notes: [],
		pluginsInstalled: [],
		pluginsUpgraded: [],
		pluginsMissing: [],
		pluginChanges: [],
		conflicts: [],
		overwritten: [],
		restartNeeded: false,
	};
}
