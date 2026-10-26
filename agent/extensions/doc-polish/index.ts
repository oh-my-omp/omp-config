// Reads the doc-polish section of omomp.* (the project copy before the agent-dir copy); reads source
// documents and writes original copies, split indexes, and reviews under /tmp/doc-polish.
// Available in main and sub sessions. Models come only from OMP model roles; a failing
// model hands the request to the next model of its role chain, while unparseable polish
// output is reported in the review without changing the source document.
// ============================================================================
// doc-polish — an omp extension that restructures a markdown/plaintext document
// for engineer readability WITHOUT changing its meaning, then emits a
// before/after/review document.
//
// Callable by the model (`polish_doc` tool) and by a human (`/polish-doc`
// slash command). The parameter is the path to a `.md`/`.txt` file (one or
// more).
//
// Three sub-agents, each its own restricted, in-memory `createAgentSession`
// bound to a model of its OMP model role (assign them in `/model`) and reusing
// the host's providers/models via `ctx.modelRegistry`:
//
//   1. Split agent   — standard subagent, tools = [read, write] only. Its
//                      prompt carries NO document text, only the task. It reads
//                      the file itself and writes a JSON split index (blocks
//                      with original line ranges + full keyword glossary).
//                      Everything after the split is program behavior.
//   2. Polish agent  — no tools. Receives batched blocks (<=5000 code points;
//                      a longer block goes alone, never truncated) plus only the glossary terms relevant
//                      to the batch; returns polished blocks + keyword-change
//                      records. Its text output is captured by the program.
//   3. Check agent   — no tools. Per regrouped block, judges whether the
//                      rewrite preserved meaning.
//
// Roles: `@doc-polish.split`, `@doc-polish.polish`, `@doc-polish.check`, each
// followed by the role named by `fallbackRole` in the doc-polish section. A
// check role with no model of its own uses the split chain. Each role entry's
// `:effort` suffix sets that model's thinking level.
// ============================================================================

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { type ExtensionAPI, type ExtensionContext, z } from "@oh-my-pi/pi-coding-agent";
import { errorText } from "../_shared/errors.ts";
import { runHelperPrompt } from "../_shared/helper-session.ts";
import { tr } from "../_shared/i18n.ts";
import { defineOmompSection, loadOmompSection } from "../_shared/omomp.ts";
import { modelLabel, type RoleModel, roleModels, roleName } from "../_shared/roles.ts";

const BATCH_LIMIT = 5000; // code points per polish request; a block over this goes alone, never truncated.

type SplitBlock = { index: number; startLine: number; endLine: number; title: string; text: string };
type PolishBlock = { sourceIndices: number[]; polished: string };
type KeywordChange = { term: string; changed: boolean; to: string; reason: string };
type PolishResult = { blocks: PolishBlock[]; changes: KeywordChange[]; diagnostics: string[] };

type Group = {
	sourceIndices: number[];
	original: string;
	polished: string;
	startLine: number;
	endLine: number;
	review: string;
};

// --- boundary schemas (parse untrusted sub-agent JSON) ----------------------

const splitSchema = z.object({
	blocks: z
		.array(
			z.object({
				index: z.number().int(),
				startLine: z.number().int().min(1),
				endLine: z.number().int().min(1),
				title: z.string().optional().default(""),
			}),
		)
		.min(1),
	keywords: z.array(z.string()).default(() => []),
});

const polishSchema = z.object({
	blocks: z
		.array(
			z.object({
				sourceIndices: z.array(z.number().int()).min(1),
				polished: z.string(),
			}),
		)
		.default(() => []),
	keywordChanges: z
		.array(
			z.object({
				term: z.string(),
				changed: z.boolean().optional().default(false),
				to: z.string().optional().default(""),
				reason: z.string().optional().default(""),
			}),
		)
		.default(() => []),
});

const configSchema = z.object({
	/** OMP model role (`default`, `@smol`, …) whose models follow every doc-polish role's own models. */
	fallbackRole: z.string().min(1).optional(),
	concurrency: z.number().int().min(1).optional(),
});

const omompSection = defineOmompSection(import.meta.dir, configSchema);

type DocPolishConfig = z.infer<typeof configSchema>;

/** The three sub-agent stages and the OMP model role each takes its models from. */
type Stage = "split" | "polish" | "check";
const stageRole = (stage: Stage): string => `${omompSection.id}.${stage}`;

// The machine-local `doc-polish` section of omomp.* (the project's `.omp/` copy
// wins over the agent-dir copy) supplies the fallback role and concurrency.
function loadConfig(cwd: string): DocPolishConfig {
	const loaded = loadOmompSection(omompSection, cwd);
	switch (loaded.kind) {
		case "found":
			return loaded.value;
		case "none":
			return {};
		default: {
			const exhaustive: never = loaded;
			return exhaustive;
		}
	}
}

// --- model resolution -------------------------------------------------------

// Raised before any work when a role this call needs resolves no model.
class DocPolishModelError extends Error {
	constructor(
		message: string,
		readonly englishMessage: string,
	) {
		super(message);
	}
}

// Raised when a sub-agent request failed on every model of its chain. Surfaced
// as a readable, self-contained error — distinct from the pre-run model check.
class DocPolishRuntimeError extends Error {
	constructor(
		message: string,
		readonly englishMessage: string,
	) {
		super(message);
	}
}

function missingModelMessage(missing: readonly Stage[], fallbackRole: string | undefined): string {
	const list = missing.map((stage) => `- \`@${stageRole(stage)}\``).join("\n");
	return [
		"doc-polish 调用失败，未做任何处理（没有拆分、润色或写文件）：这些 OMP 模型角色没有解析到任何可用模型（只核对模型列表，未发送请求）：",
		list,
		"",
		"三个角色的作用：",
		`- \`@${stageRole("split")}\`（拆分）：读取文档、按相关性切成小块、标注每块在原文的起止行号、抽取关键词词表；需要 read+write 工具能力。`,
		`- \`@${stageRole("polish")}\`（润色）：在不改变原意的前提下，把每个批次重排/润色成工程师更易读的文本，并给出词表变更；无工具。`,
		`- \`@${stageRole("check")}\`（校验）：对合并后的每个编组判断语义是否保持、如何理解；无工具。没有自己的模型时使用拆分角色的模型。`,
		"",
		fallbackRole === undefined
			? "在 `/model` 里给这些角色指定模型后重新调用；或在 omomp 的 `doc-polish` 段设置 `fallbackRole`。"
			: `在 \`/model\` 里给这些角色或回退角色 \`@${roleName(fallbackRole)}\` 指定模型后重新调用。`,
	].join("\n");
}

function missingModelEnglishMessage(missing: readonly Stage[], fallbackRole: string | undefined): string {
	const list = missing.map((stage) => `- \`@${stageRole(stage)}\``).join("\n");
	return [
		"doc-polish failed; no work was performed (no splitting, polishing, or file writes): these OMP model roles resolved to no usable models (only the model list was checked; no request was sent):",
		list,
		"",
		"What the three roles do:",
		`- \`@${stageRole("split")}\` (split): reads the document, divides it into relevant blocks, records each block's original line range, and extracts a keyword glossary; requires read+write tool access.`,
		`- \`@${stageRole("polish")}\` (polish): reorders/polishes each batch into text that is easier for engineers to read without changing its meaning, and reports glossary changes; no tools.`,
		`- \`@${stageRole("check")}\` (check): judges whether each regrouped block preserves its meaning and how it should be understood; no tools. When it has no model of its own, it uses the split role's models.`,
		"",
		fallbackRole === undefined
			? "Assign models to these roles in `/model` and call again, or set `fallbackRole` in the `doc-polish` section of omomp."
			: `Assign models to these roles or the fallback role \`@${roleName(fallbackRole)}\` in \`/model\` and call again.`,
	].join("\n");
}

function stageLabel(stage: Stage, language: "en" | "zh"): string {
	switch (stage) {
		case "split":
			return language === "en" ? "split" : "拆分";
		case "polish":
			return language === "en" ? "polish" : "润色";
		case "check":
			return language === "en" ? "check" : "校验";
		default: {
			const exhaustive: never = stage;
			return exhaustive;
		}
	}
}

// --- sub-agent runner (createAgentSession, reusing host providers) ----------

type SubSessionOptions = {
	/** The stage's role chain, in order. */
	models: readonly RoleModel[];
	stage: Stage;
	toolNames: string[];
	prompt: string;
	agentId: string;
	cwd: string;
	/** Receives the `provider/id` of the model that answered. */
	used: Set<string>;
	/** Runs before every model's attempt, e.g. to clear a file the previous model left. */
	beforeAttempt?: () => void;
};

// Each model of the chain in turn: a provider error or a failed helper session hands
// the request to the next model; the first text answer wins. Every model failing is a
// readable, self-contained error. A response that merely fails to parse is handled by
// the caller, not here.
async function runSubSession(ctx: ExtensionContext, opts: SubSessionOptions): Promise<string> {
	const failures: string[] = [];
	for (const { model, level } of opts.models) {
		opts.beforeAttempt?.();
		const result = await runHelperPrompt(ctx, {
			cwd: opts.cwd,
			model,
			thinkingLevel: level,
			toolNames: opts.toolNames,
			prompt: opts.prompt,
			agentId: opts.agentId,
			systemPrompt: "default",
		});
		switch (result.kind) {
			case "text":
				opts.used.add(modelLabel(model));
				return result.text;
			case "provider-error":
				failures.push(`\`${modelLabel(model)}\`：${result.message || "模型返回错误（stopReason=error）"}`);
				continue;
			case "failed":
				failures.push(`\`${modelLabel(model)}\`：${result.message}`);
				continue;
			case "canceled":
				// No signal is passed: cancellation cannot originate from this caller.
				throw new Error("doc-polish: sub-agent canceled");
			default: {
				const exhaustive: never = result;
				return exhaustive;
			}
		}
	}
	throw new DocPolishRuntimeError(
		`doc-polish：${stageLabel(opts.stage, "zh")}子代理在角色链的每个模型上都调用失败：${failures.join("；")}`,
		`doc-polish: ${stageLabel(opts.stage, "en")} sub-agent failed on every model in its role chain: ${failures.join("; ")}`,
	);
}

// --- JSON parsing (tolerant of code fences) ---------------------------------

function extractJson(raw: string): string {
	let text = raw.trim();
	// Strip an outer code fence ONLY when the whole payload is fenced. Never match a
	// fence that appears inside the JSON — a `polished` string may itself contain a
	// ```mermaid``` block, and a greedy fence match would slice out its body.
	if (text.startsWith("```")) {
		const firstNewline = text.indexOf("\n");
		if (firstNewline >= 0) text = text.slice(firstNewline + 1);
		if (text.endsWith("```")) text = text.slice(0, -3);
		text = text.trim();
	}
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

// --- batching ---------------------------------------------------------------

function codePoints(text: string): number {
	let n = 0;
	for (const _ of text) n++;
	return n;
}

// Pack blocks into batches of <=BATCH_LIMIT code points without truncation.
// A block that alone exceeds the limit becomes its own batch.
function batchBlocks(blocks: SplitBlock[]): SplitBlock[][] {
	const batches: SplitBlock[][] = [];
	let current: SplitBlock[] = [];
	let size = 0;
	for (const block of blocks) {
		const blockSize = codePoints(block.text);
		if (current.length > 0 && size + blockSize > BATCH_LIMIT) {
			batches.push(current);
			current = [];
			size = 0;
		}
		current.push(block);
		size += blockSize;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

function relevantKeywords(keywords: string[], batchText: string): string[] {
	const haystack = batchText.toLowerCase();
	return keywords.filter((k) => k.trim().length > 0 && haystack.includes(k.toLowerCase()));
}

const DEFAULT_CONCURRENCY = 6;

// Structured concurrency: run `fn` over `items` with at most `limit` in flight,
// await them all, and return results in input order. Splitting the document is
// what makes this parallelism possible; the ordered result lets the caller
// reassemble and write strictly by index.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
	const workers = Array.from({ length: width }, async () => {
		for (let i = next++; i < items.length; i = next++) {
			const item = items[i];
			// The loop claims only valid indices; an undefined value is not an item.
			if (item === undefined) throw new Error("doc-polish: missing concurrent work item");
			results[i] = await fn(item, i);
		}
	});
	await Promise.all(workers);
	return results;
}

// --- regroup (union-find over source indices linked by polished blocks) -----

function regroup(blocks: SplitBlock[], polished: PolishBlock[]): Group[] {
	const byIndex = new Map(blocks.map((b) => [b.index, b]));
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		let cur = x;
		while (parent.get(cur) !== root) {
			const next = parent.get(cur)!;
			parent.set(cur, root);
			cur = next;
		}
		return root;
	};
	for (const b of blocks) parent.set(b.index, b.index);
	// polished text keyed by the representative source index of each polished block
	const polishedByRep = new Map<number, string[]>();
	for (const pb of polished) {
		const known = pb.sourceIndices.filter((i) => byIndex.has(i));
		if (known.length === 0) continue;
		const rep0 = known[0];
		if (rep0 === undefined) continue;
		for (const i of known.slice(1)) {
			const a = find(rep0);
			const b = find(i);
			if (a !== b) parent.set(a, b);
		}
	}
	// attach polished text to each block's group root
	for (const pb of polished) {
		const known = pb.sourceIndices.filter((i) => byIndex.has(i));
		if (known.length === 0) continue;
		const first = known[0];
		if (first === undefined) continue;
		const root = find(first);
		const list = polishedByRep.get(root) ?? [];
		list.push(pb.polished);
		polishedByRep.set(root, list);
	}
	const groupsByRoot = new Map<number, number[]>();
	for (const b of blocks) {
		const root = find(b.index);
		const list = groupsByRoot.get(root) ?? [];
		list.push(b.index);
		groupsByRoot.set(root, list);
	}
	const groups: Group[] = [];
	for (const [root, indices] of groupsByRoot) {
		const sorted = indices.sort((a, b) => a - b);
		const members = sorted.map((i) => byIndex.get(i)!);
		const original = members.map((m) => m.text).join("\n\n");
		const polishedText = (polishedByRep.get(root) ?? []).join("\n\n").trim() || "(润色未覆盖此块)";
		groups.push({
			sourceIndices: sorted,
			original,
			polished: polishedText,
			startLine: Math.min(...members.map((m) => m.startLine)),
			endLine: Math.max(...members.map((m) => m.endLine)),
			review: "",
		});
	}
	return groups.sort((a, b) => (a.sourceIndices[0] ?? 0) - (b.sourceIndices[0] ?? 0));
}

// --- prompts ----------------------------------------------------------------

function splitPrompt(absOriginal: string, absOut: string, kind: string, lineCount: number): string {
	return [
		"You are a document STRUCTURING pass. Do NOT rewrite, translate, or polish — only segment and index.",
		"",
		"Steps:",
		`1. Use the read tool to read the file at: ${absOriginal}`,
		`   It is a ${kind} document with ${lineCount} lines.`,
		"2. Segment it into small paragraph-sized blocks grouped by topical relevance.",
		"   Blocks are contiguous, non-overlapping, in original order, and together cover every",
		"   non-empty line from start to end.",
		"3. Extract the COMPLETE keyword glossary: every salient domain term, name, and identifier",
		"   in the document, deduplicated.",
		`4. Use the write tool to write ONLY the following JSON (no prose) to: ${absOut}`,
		"",
		"JSON schema:",
		'{ "blocks": [ { "index": <int 0-based ascending>, "startLine": <1-based inclusive>,',
		'  "endLine": <1-based inclusive>, "title": "<short topic label>" } ],',
		'  "keywords": ["term", ...] }',
		"",
		"Rules: startLine/endLine reference the ORIGINAL file's line numbers. Do NOT include block",
		"text (the program reads it from the offsets). Do not alter the document. After the write",
		"tool succeeds, stop.",
	].join("\n");
}

function polishPrompt(batch: SplitBlock[], keywords: string[]): string {
	const blockText = batch.map((b) => `[index ${b.index}] (${b.title || "untitled"})\n${b.text}`).join("\n\n");
	return [
		"You are an engineering-focused editor. Rewrite the provided content for a software-engineer",
		"reader: clearer structure, tighter prose, better paragraph ordering WITHIN the provided",
		"content — while PRESERVING the original meaning exactly. Do not add or drop information.",
		"Keep the same language as the source.",
		"",
		"You MAY merge adjacent blocks when it improves readability; when you do, list ALL merged",
		"source indices in that output block. Cover every provided source index exactly once across",
		"all output blocks, in ascending source-index order.",
		"",
		"Return ONLY JSON (no prose, no code fence):",
		'{ "blocks": [ { "sourceIndices": [<int>...], "polished": "<rewritten text>" } ],',
		'  "keywordChanges": [ { "term": "<glossary term>", "changed": true, "to": "<new term if changed>", "reason": "<short, only when changed>" } ] }',
		'For each glossary term you touched, set "changed" to true or false; when false, omit "to" and "reason".',
		"",
		keywords.length > 0 ? `Relevant glossary: ${keywords.join(", ")}` : "Relevant glossary: (none)",
		"",
		"Source blocks:",
		blockText,
	].join("\n");
}

function checkPrompt(original: string, polished: string): string {
	return [
		"Compare a SOURCE passage with its REWRITE. Decide whether the meaning is preserved.",
		"Output a concise review (2–5 sentences) in the SAME language as the text: state whether",
		"meaning is preserved, flag any added/removed/altered claims, and note how a reader should",
		"understand the rewrite. Do NOT rewrite the text.",
		"",
		"--- SOURCE ---",
		original,
		"",
		"--- REWRITE ---",
		polished,
	].join("\n");
}

// --- core pipeline ----------------------------------------------------------

type Progress = (english: string, chinese: string) => void;
type StageModels = Readonly<Record<Stage, readonly RoleModel[]>>;
type StageUsed = Readonly<Record<Stage, Set<string>>>;

async function polishOneFile(
	ctx: ExtensionContext,
	absPath: string,
	models: StageModels,
	progress: Progress,
	concurrency: number,
): Promise<string> {
	const ext = extname(absPath).toLowerCase();
	if (ext !== ".md" && ext !== ".txt") {
		throw new Error(`doc-polish: expected a .md or .txt file, got "${absPath}"`);
	}
	if (!existsSync(absPath) || !statSync(absPath).isFile()) {
		throw new Error(`doc-polish: file not found: ${absPath}`);
	}
	const originalText = readFileSync(absPath, "utf8");
	const originalLines = originalText.split("\n");

	// /tmp workspace: copy the original, build the review beside it.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const workspace = join("/tmp", "doc-polish", `${stamp}-${basename(absPath, ext)}`);
	mkdirSync(workspace, { recursive: true });
	const originalCopy = join(workspace, `original${ext}`);
	copyFileSync(absPath, originalCopy);
	const splitOut = join(workspace, "split.json");
	const reviewPath = join(workspace, "review.md");
	const used: StageUsed = { split: new Set(), polish: new Set(), check: new Set() };

	// 1. Split agent (standard subagent: read + write only, no document text in prompt).
	progress(`[${basename(absPath)}] Splitting…`, `[${basename(absPath)}] 拆分中…`);
	await runSubSession(ctx, {
		models: models.split,
		stage: "split",
		toolNames: ["read", "write"],
		prompt: splitPrompt(absPath, splitOut, ext === ".md" ? "Markdown" : "plain-text", originalLines.length),
		agentId: `docpolish-split-${stamp}`,
		cwd: workspace,
		used: used.split,
		// A model that failed after writing part of the index must not hand it to the next one.
		beforeAttempt: () => rmSync(splitOut, { force: true }),
	});
	if (!existsSync(splitOut)) {
		throw new Error(`doc-polish: split agent did not write ${splitOut}`);
	}
	const splitParsed = splitSchema.parse(JSON.parse(extractJson(readFileSync(splitOut, "utf8"))));

	// Derive AUTHORITATIVE block text from the original file's line ranges.
	const blocks: SplitBlock[] = splitParsed.blocks
		.map((b, i) => {
			const start = Math.max(1, Math.min(b.startLine, originalLines.length));
			const end = Math.max(start, Math.min(b.endLine, originalLines.length));
			return {
				index: Number.isInteger(b.index) ? b.index : i,
				startLine: start,
				endLine: end,
				title: b.title ?? "",
				text: originalLines
					.slice(start - 1, end)
					.join("\n")
					.trim(),
			};
		})
		.filter((b) => b.text.length > 0)
		.sort((a, b) => a.startLine - b.startLine);
	if (blocks.length === 0) throw new Error("doc-polish: split produced no usable blocks");
	const keywords = splitParsed.keywords;

	// 2. Batch, then polish every batch concurrently (structured concurrency:
	//    launch all, await all, reassemble by batch order). Splitting the document
	//    is precisely what lets the blocks be analyzed in parallel.
	const batches = batchBlocks(blocks);
	let polished = 0;
	const batchResults = await mapLimit<SplitBlock[], PolishResult>(batches, concurrency, async (batch, i) => {
		const batchText = batch.map((b) => b.text).join("\n");
		const kws = relevantKeywords(keywords, batchText);
		const raw = await runSubSession(ctx, {
			models: models.polish,
			stage: "polish",
			toolNames: [],
			prompt: polishPrompt(batch, kws),
			agentId: `docpolish-polish-${stamp}-${i}`,
			cwd: workspace,
			used: used.polish,
		});
		progress(
			`[${basename(absPath)}] Polishing ${++polished}/${batches.length}…`,
			`[${basename(absPath)}] 润色 ${polished}/${batches.length}…`,
		);
		try {
			const p = polishSchema.parse(JSON.parse(extractJson(raw)));
			return { blocks: p.blocks, changes: p.keywordChanges, diagnostics: [] };
		} catch (err) {
			// Fall back to a 1:1 identity mapping for this batch so the pipeline still completes.
			return {
				blocks: batch.map((b) => ({ sourceIndices: [b.index], polished: `(润色输出解析失败) ${b.text}` })),
				changes: [],
				diagnostics: [`批次 ${i + 1} 润色输出解析失败（raw ${[...raw].length} 字，${JSON.stringify(raw.slice(0, 120))}）：${String(err)}`],
			};
		}
	});
	const polishedBlocks: PolishBlock[] = batchResults.flatMap((r) => r.blocks);
	const keywordChanges: KeywordChange[] = batchResults.flatMap((r) => r.changes);
	const diagnostics: string[] = batchResults.flatMap((r) => r.diagnostics);

	// 3. Regroup (detect merges via sourceIndices), then meaning-check every group
	//    concurrently; assign the reviews back by index.
	const groups = regroup(blocks, polishedBlocks);
	let checked = 0;
	const reviews = await mapLimit<Group, string>(groups, concurrency, async (g, i) => {
		const review = await runSubSession(ctx, {
			models: models.check,
			stage: "check",
			toolNames: [],
			prompt: checkPrompt(g.original, g.polished),
			agentId: `docpolish-check-${stamp}-${i}`,
			cwd: workspace,
			used: used.check,
		});
		progress(`[${basename(absPath)}] Checking ${++checked}/${groups.length}…`, `[${basename(absPath)}] 校验 ${checked}/${groups.length}…`);
		return review;
	});
	reviews.forEach((review, i) => {
		const group = groups[i];
		if (!group) throw new Error("doc-polish: missing review group");
		group.review = review;
	});

	// 4. Write the before/after/review document.
	writeFileSync(reviewPath, renderReview(absPath, originalCopy, used, keywordChanges, groups, diagnostics), "utf8");
	return reviewPath;
}

function renderReview(
	source: string,
	originalCopy: string,
	used: StageUsed,
	keywordChanges: KeywordChange[],
	groups: Group[],
	diagnostics: string[],
): string {
	const lines: string[] = [];
	lines.push(`# 润色评审：${basename(source)}`);
	lines.push("");
	lines.push(`- 源文件：\`${source}\``);
	lines.push(`- 原文副本：\`${originalCopy}\``);
	lines.push(`- 生成时间：${new Date().toISOString()}`);
	const usedLine = (models: Set<string>) => [...models].map((label) => `\`${label}\``).join("、") || "（无）";
	lines.push(`- 拆分模型：${usedLine(used.split)}（角色 \`@${stageRole("split")}\`）`);
	lines.push(`- 润色模型：${usedLine(used.polish)}（角色 \`@${stageRole("polish")}\`）`);
	lines.push(`- 校验模型：${usedLine(used.check)}（角色 \`@${stageRole("check")}\`）`);
	lines.push("");
	lines.push("## 词表变更记录");
	const cell = (s: string) =>
		s
			.replace(/\|/g, "\\|")
			.replace(/\r?\n+/g, " ")
			.trim();
	const rows = keywordChanges
		.filter((c) => c.term.trim())
		.map((c) => ({
			term: c.term,
			to: c.to,
			reason: c.reason,
			isChanged: c.changed === true || (c.to.trim().length > 0 && c.to.trim() !== c.term.trim()),
		}))
		.sort((a, b) => Number(b.isChanged) - Number(a.isChanged));
	if (rows.length === 0) {
		lines.push("（无）");
	} else {
		lines.push("| 词条 | 是否变更 | 变更后 | 理由 |");
		lines.push("|---|---|---|---|");
		for (const c of rows) {
			lines.push(
				`| \`${cell(c.term)}\` | ${c.isChanged ? "是" : "否"} | ${c.isChanged ? cell(c.to) : ""} | ${c.isChanged ? cell(c.reason) : ""} |`,
			);
		}
	}
	if (diagnostics.length > 0) {
		lines.push("");
		lines.push("### 处理告警");
		for (const d of diagnostics) lines.push(`- ${cell(d)}`);
	}
	lines.push("");
	groups.forEach((g, i) => {
		lines.push(`## 段落 ${i + 1}（原文块 ${g.sourceIndices.join(", ")}，第 ${g.startLine}–${g.endLine} 行）`);
		if (g.sourceIndices.length > 1) lines.push(`> 合并了 ${g.sourceIndices.length} 个原始块。`);
		lines.push("");
		lines.push("### 改之前");
		lines.push("");
		lines.push(g.original);
		lines.push("");
		lines.push("### 改之后");
		lines.push("");
		lines.push(g.polished);
		lines.push("");
		lines.push("### 点评");
		lines.push("");
		lines.push(g.review.trim() || "（校验未返回）");
		lines.push("");
	});
	return lines.join("\n");
}

// --- shared entry used by both the tool and the slash command ---------------

type PolishOptions = {
	paths: string[];
	concurrency?: number;
};

async function polishDocuments(
	ctx: ExtensionContext,
	options: PolishOptions,
	progress: Progress,
): Promise<{ source: string; review: string }[]> {
	const config = loadConfig(ctx.cwd);
	// Each stage's role, then the configured fallback role; resolved per call so `/model` changes apply.
	const chain = (stage: Stage): RoleModel[] =>
		roleModels(ctx, config.fallbackRole === undefined ? [stageRole(stage)] : [stageRole(stage), config.fallbackRole]);
	const split = chain("split");
	const polish = chain("polish");
	const missing: Stage[] = [];
	if (split.length === 0) missing.push("split");
	if (polish.length === 0) missing.push("polish");
	if (missing.length > 0)
		throw new DocPolishModelError(
			missingModelMessage(missing, config.fallbackRole),
			missingModelEnglishMessage(missing, config.fallbackRole),
		);
	// A check role with no model of its own uses the whole split chain.
	const check = roleModels(ctx, [stageRole("check")]).length === 0 ? split : chain("check");
	const models: StageModels = { split, polish, check };
	const concurrency = options.concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;
	const results: { source: string; review: string }[] = [];
	for (const p of options.paths) {
		const abs = isAbsolute(p) ? p : resolvePath(ctx.cwd, p);
		const review = await polishOneFile(ctx, abs, models, progress, concurrency);
		results.push({ source: abs, review });
	}
	return results;
}

// Result text handed to an agent consumer — an LLM tool result, or (for the
// human slash command) the current session's main agent. Frames the rewrite as
// a reference direction the caller must evaluate, not an authoritative edit.
function buildAgentResultText(results: { source: string; review: string }[]): string {
	const list = results.map((r) => `- ${basename(r.source)}: ${r.review}`).join("\n");
	return [
		`已生成 ${results.length} 份润色评审（改之前 / 改之后 / 点评），文件路径：`,
		list,
		"",
		"用途说明：这些评审是参考方向，不是权威结论。其中的“改之后”只是对该段的一种可选重写，",
		"“点评”给出该改写是否偏离原意、应如何理解。请阅读评审文件，逐段自行判断哪些改写值得采纳、",
		"以何种方式融入，而不是直接用改写替换原文。",
		"",
		"处理要求（针对你本人，不得转交）：",
		"1. 这是你自己的工作，必须由你亲自完成——禁止委托、下发或交给任何子代理 / 其他 agent 代读或代为处理。",
		"2. 阅读评审时禁止一切截断读取：不得使用 offset/limit、行范围、分页，或只读开头 / 摘要 / 节选；必须把每一份评审文件从头到尾完整读完，再逐段判断。",
	].join("\n");
}

// --- extension registration -------------------------------------------------

const polishOptionsSchema = z.object({
	paths: z.array(z.string()).min(1).describe("Absolute or cwd-relative paths to .md or .txt files (one sub-agent pipeline per file)."),
	concurrency: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Max parallel polish/check sub-agents (structured concurrency: blocks analyzed in parallel, written by index). Defaults to 6.",
		),
});

export default function docPolish(pi: ExtensionAPI): void {
	pi.setLabel(tr("Doc Polish", "文档润色"));

	pi.registerTool({
		name: "polish_doc",
		label: tr("Polish Doc", "润色文档"),
		description:
			"Restructure a .md/.txt document for engineer readability WITHOUT changing its meaning. Use it when a " +
			"document's content is settled and only readability remains — e.g. after finishing a draft and before " +
			"turning it into the formal document, or when handing a doc off for others to read. It emits a " +
			"before/after/review file under /tmp/doc-polish and RETURNS its path. Splits the " +
			"document with a read+write sub-agent, polishes batched paragraphs (<=5000 code points, never " +
			"truncated) with tool-less sub-agents in parallel, regroups merged paragraphs, then meaning-checks each " +
			"group. Models come from the OMP model roles `@doc-polish.split`, `@doc-polish.polish` and " +
			"`@doc-polish.check` (assigned in `/model`). The '改之后' rewrite is a REFERENCE direction, not an " +
			"authoritative result: the caller must read the review and decide what, if anything, to adopt.",
		parameters: polishOptionsSchema,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const progress: Progress = (_english, chinese) => onUpdate?.({ content: [{ type: "text", text: chinese }] });
			try {
				const results = await polishDocuments(ctx, polishOptionsSchema.parse(params), progress);
				return {
					content: [{ type: "text", text: buildAgentResultText(results) }],
					details: { results, reviewPaths: results.map((r) => r.review), reference: true },
				};
			} catch (err) {
				if (err instanceof DocPolishModelError) {
					return { content: [{ type: "text", text: err.message }], details: { modelError: true }, isError: true };
				}
				if (err instanceof DocPolishRuntimeError) {
					return { content: [{ type: "text", text: err.message }], details: { runtimeError: true }, isError: true };
				}
				throw err;
			}
		},
	});

	pi.registerCommand("polish-doc", {
		description: tr(
			"Polish documents: /polish-doc <path.md|path.txt> [more paths…]",
			"润色文档：/polish-doc <path.md|path.txt> [更多路径…]",
		),
		handler: async (args, ctx) => {
			const paths = args.trim().split(/\s+/).filter(Boolean);
			if (paths.length === 0) {
				ctx.ui.notify(
					tr("Usage: /polish-doc <path.md|path.txt> [more paths…]", "用法：/polish-doc <path.md|path.txt> [更多路径…]"),
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				tr(
					`doc-polish: processing ${paths.length} file(s); the result will be delivered to the main agent when complete…`,
					`doc-polish：开始处理 ${paths.length} 个文件，完成后把结果交给主 agent…`,
				),
				"info",
			);
			try {
				const results = await polishDocuments(ctx, { paths }, (english, chinese) => ctx.ui.setStatus?.("doc-polish", tr(english, chinese)));
				// Human invocation differs from an LLM tool call: deliver the result to the
				// current session's main agent as fresh input (it decides how to use the
				// reference), rather than displaying it to the human.
				void pi.sendUserMessage(buildAgentResultText(results), { attribution: "agent" });
			} catch (err) {
				pi.logger.warn("doc-polish command failed", { error: errorText(err) });
				if (err instanceof DocPolishModelError || err instanceof DocPolishRuntimeError) {
					ctx.ui.notify(tr(err.englishMessage, err.message), "error");
				} else {
					const message = String(err);
					ctx.ui.notify(tr(`doc-polish failed: ${message}`, `doc-polish 失败：${message}`), "error");
				}
			} finally {
				// Progress ran through ctx.ui.setStatus (a persistent footer entry, unlike
				// the tool path's transient onUpdate). Clear it on the way out — success or
				// failure — so the footer doesn't keep the last progress line forever.
				ctx.ui.setStatus?.("doc-polish", undefined);
			}
		},
	});
}
