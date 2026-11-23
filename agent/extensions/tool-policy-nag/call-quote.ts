export function quotedCall(text: string, language: string): string {
	let longest = 2;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const marks = "`".repeat(longest + 1);
	return `这次调用：\n${marks}${language}\n${text}\n${marks}`;
}
