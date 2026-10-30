// Process helpers for the host side of the sandbox: run a command and capture its output, or
// pipe one command's stdout into another's stdin. Every failure carries the command and its
// stderr; callers decide whether a failure aborts the step.

export interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export class CommandError extends Error {}

/** Runs `argv` to completion. `input` is written to its stdin. */
export async function run(argv: readonly string[], input?: Uint8Array | string): Promise<Ran> {
	const proc = Bun.spawn([...argv], { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
	if (input !== undefined && proc.stdin !== undefined) {
		proc.stdin.write(input);
		await proc.stdin.end();
	}
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

/** Runs `argv` and returns its stdout; a nonzero exit throws with the command and its stderr. */
export async function must(argv: readonly string[], input?: Uint8Array | string): Promise<string> {
	const result = await run(argv, input);
	if (result.code !== 0) throw new CommandError(`${argv.join(" ")} exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
	return result.stdout;
}

/** Runs `argv` and returns its stdout as bytes; a nonzero exit throws. */
export async function mustBytes(argv: readonly string[]): Promise<Uint8Array> {
	const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [bytes, stderr, code] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new CommandError(`${argv.join(" ")} exited ${code}: ${stderr.trim()}`);
	return bytes;
}

/** `producer | consumer`; either side failing throws. Nothing passes through a file. */
export async function pipe(producer: readonly string[], consumer: readonly string[], producerInput?: string): Promise<void> {
	const left = Bun.spawn([...producer], { stdin: producerInput === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
	if (producerInput !== undefined && left.stdin !== undefined) {
		left.stdin.write(producerInput);
		await left.stdin.end();
	}
	const right = Bun.spawn([...consumer], { stdin: left.stdout, stdout: "pipe", stderr: "pipe" });
	const [leftErr, rightOut, rightErr, leftCode, rightCode] = await Promise.all([
		new Response(left.stderr).text(),
		new Response(right.stdout).text(),
		new Response(right.stderr).text(),
		left.exited,
		right.exited,
	]);
	if (leftCode !== 0) throw new CommandError(`${producer.join(" ")} exited ${leftCode}: ${leftErr.trim()}`);
	if (rightCode !== 0) throw new CommandError(`${consumer.join(" ")} exited ${rightCode}: ${rightErr.trim() || rightOut.trim()}`);
}
