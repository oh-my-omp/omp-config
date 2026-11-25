import { type AskToolDetails, z, type zod } from "@oh-my-pi/pi-coding-agent";

type AskAnswer = { readonly question: string; readonly answer: string };
type OptionNote = NonNullable<AskToolDetails["notes"]>[number];

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

const batchDetails = z.object({ results: z.array(questionResult) });

function answerOf(result: { selectedOptions: readonly string[]; customInput?: string | undefined }): string | null {
	const custom = result.customInput?.trim();
	const picked = result.selectedOptions.join(", ");
	if (custom && picked) return `${picked} + "${custom}"`;
	if (custom) return `"${custom}"`;
	return picked || null;
}

function foldLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function noteBracket(note: OptionNote): string | null {
	const text = foldLine(note.text);
	return text === "" ? null : `[note: ${foldLine(note.option)} — ${text}]`;
}

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

export function askAnswers(message: {
	readonly toolName?: unknown;
	readonly isError?: unknown;
	readonly details?: unknown;
}): AskAnswer[] | null {
	if (message.toolName !== "ask" || message.isError === true) return null;
	const host = hostDetails.safeParse(message.details);
	return host.success ? hostAnswers(host.data) : legacyAnswers(message.details);
}

export function formatAskAnswers(answers: readonly AskAnswer[]): string {
	return answers.map((a) => `${a.question} → ${a.answer}`).join("\n");
}
