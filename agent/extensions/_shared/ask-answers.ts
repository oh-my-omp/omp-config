import { z } from "@oh-my-pi/pi-coding-agent";

/**
 * What the user answered in one `ask` call, read from its tool result. The
 * native tool and the omp-ask-more plugin both report `details.results[]`
 * (`id`, `question`, `selectedOptions`, `customInput`) and keep the tool
 * name `ask`. A single native question may report its answer at the top of
 * `details` instead; both shapes are read. Returns null when the result is an
 * error, carries no answer at all, or is not an ask result, so a cancelled or
 * refused ask never reads as a decision.
 */
export type AskAnswer = { readonly question: string; readonly answer: string };

const questionResult = z.object({
	question: z.string(),
	selectedOptions: z.array(z.string()),
	customInput: z.string().optional(),
});

// Two shapes parsed one after the other: the host's `z` cannot build a union of
// objects whose optional fields overlap ("unordered union … is indeterminate").
const batchDetails = z.object({ results: z.array(questionResult) });

function answerOf(result: { selectedOptions: readonly string[]; customInput?: string | undefined }): string | null {
	const custom = result.customInput?.trim();
	const picked = result.selectedOptions.join(", ");
	if (custom && picked) return `${picked} + "${custom}"`;
	if (custom) return `"${custom}"`;
	return picked || null;
}

/** The answered questions of an `ask` tool-result message; null when it holds none. */
export function askAnswers(message: {
	readonly toolName?: unknown;
	readonly isError?: unknown;
	readonly details?: unknown;
}): AskAnswer[] | null {
	if (message.toolName !== "ask" || message.isError === true) return null;
	const batch = batchDetails.safeParse(message.details);
	const single = batch.success ? undefined : questionResult.safeParse(message.details);
	const results = batch.success ? batch.data.results : single?.success ? [single.data] : null;
	if (results === null) return null;
	const answers: AskAnswer[] = [];
	for (const result of results) {
		const answer = answerOf(result);
		if (answer !== null) answers.push({ question: result.question, answer });
	}
	return answers.length === 0 ? null : answers;
}

/** One line per answered question: `question → answer`. */
export function formatAskAnswers(answers: readonly AskAnswer[]): string {
	return answers.map((a) => `${a.question} → ${a.answer}`).join("\n");
}
