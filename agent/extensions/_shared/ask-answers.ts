import { z, type zod } from "@oh-my-pi/pi-coding-agent";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";

/**
 * What the user answered in one `ask` call, read from its tool result. The
 * host's `ask` reports `details.answers[]` (one `FormAnswer` per named form
 * field), its selected-option notes in `details.notes[]`, and `timedOut: true`
 * when the deadline submitted the form's current values instead of the user.
 * The omp-ask-more plugin reports `details.results[]` (`question`,
 * `selectedOptions`, `customInput`), and a single question's
 * `{ question, selectedOptions, customInput? }` at the top of `details` was
 * persisted by older sessions; both stay readable. Returns null when the
 * result is an error, is not an ask result, carries no answer at all, or is a
 * timed-out submission, so a cancelled, refused or auto-selected ask never
 * reads as a decision.
 */
type AskAnswer = { readonly question: string; readonly answer: string };
type OptionNote = NonNullable<AskToolDetails["notes"]>[number];

/**
 * The host's `AskToolDetails`, parsed at the boundary. Annotated with the host
 * type: a field the host renames or retypes fails `tsc` here instead of
 * turning every answer into a silent null.
 */
const hostDetails: zod.ZodLikeSchema<AskToolDetails> = z.object({
	answers: z.array(z.object({ name: z.string(), question: z.string(), answer: z.string() })),
	notes: z.array(z.object({ name: z.string(), question: z.string(), option: z.string(), value: z.string(), text: z.string() })).optional(),
	timedOut: z.boolean().optional(),
});

const questionResult = z.object({
	question: z.string(),
	selectedOptions: z.array(z.string()),
	customInput: z.string().optional(),
});

// Two legacy shapes parsed one after the other: the host's `z` cannot build a
// union of objects whose optional fields overlap ("unordered union … is indeterminate").
const batchDetails = z.object({ results: z.array(questionResult) });

function answerOf(result: { selectedOptions: readonly string[]; customInput?: string | undefined }): string | null {
	const custom = result.customInput?.trim();
	const picked = result.selectedOptions.join(", ");
	if (custom && picked) return `${picked} + "${custom}"`;
	if (custom) return `"${custom}"`;
	return picked || null;
}

/** Text folded onto one line: each run of whitespace, newlines and tabs becomes one space, then trimmed. */
function foldLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A note's bracket on its answer line; null when its text folds to nothing. */
function noteBracket(note: OptionNote): string | null {
	const text = foldLine(note.text);
	return text === "" ? null : `[note: ${foldLine(note.option)} — ${text}]`;
}

/** The host's answers: one line per non-blank field, with the notes paired to it appended. */
function hostAnswers(details: AskToolDetails): AskAnswer[] | null {
	if (details.timedOut === true) return null;
	const notes = details.notes ?? [];
	const answers: AskAnswer[] = [];
	for (const field of details.answers) {
		const answer = foldLine(field.answer);
		if (answer === "") continue;
		const brackets = notes
			.filter((note) => note.name === field.name && note.question === field.question)
			.flatMap((note) => noteBracket(note) ?? []);
		answers.push({ question: foldLine(field.question), answer: [answer, ...brackets].join(" ") });
	}
	return answers.length === 0 ? null : answers;
}

/** The legacy `results[]` or single-question shape; null when neither holds. */
function legacyAnswers(details: unknown): AskAnswer[] | null {
	const batch = batchDetails.safeParse(details);
	const single = batch.success ? undefined : questionResult.safeParse(details);
	const results = batch.success ? batch.data.results : single?.success ? [single.data] : null;
	if (results === null) return null;
	const answers: AskAnswer[] = [];
	for (const result of results) {
		const answer = answerOf(result);
		if (answer !== null) answers.push({ question: result.question, answer });
	}
	return answers.length === 0 ? null : answers;
}

/** The answered questions of an `ask` tool-result message; null when it holds none. */
export function askAnswers(message: {
	readonly toolName?: unknown;
	readonly isError?: unknown;
	readonly details?: unknown;
}): AskAnswer[] | null {
	if (message.toolName !== "ask" || message.isError === true) return null;
	const host = hostDetails.safeParse(message.details);
	return host.success ? hostAnswers(host.data) : legacyAnswers(message.details);
}

/** One line per answered question: `question → answer`. */
export function formatAskAnswers(answers: readonly AskAnswer[]): string {
	return answers.map((a) => `${a.question} → ${a.answer}`).join("\n");
}
