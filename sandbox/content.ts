import { existsSync } from "node:fs";
import { join } from "node:path";
import { compareImages, snapshot, type TableCheck } from "./agentdb.ts";
import { must, mustBytes, pipe } from "./docker.ts";

export const IMAGE = "oven/bun:latest";
export const TARGET_IMAGE = "debian:stable-slim";
export const PLATFORM = "linux/arm64";
const TAR_FLAGS = ["--no-xattrs", "--no-mac-metadata"];

const AGENT_EXCLUDES = [
	"agent/sessions",
	"agent/blobs",
	"agent/terminal-sessions",
	"agent/custom-session-files",
	"agent/predict",
	"agent/cache",
	"agent/history.db*",
	"agent/agent.db*",
	"agent/*.lock",
	"plugins/node_modules",
];

export async function installTools(container: string): Promise<void> {
	await must([
		"docker",
		"exec",
		container,
		"sh",
		"-c",
		"apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git openssh-client python3 zsh jq sqlite3 procps ca-certificates >/dev/null",
	]);
}

export async function copyOmpDir(container: string, home: string): Promise<void> {
	const excludes = AGENT_EXCLUDES.map((pattern) => `--exclude=${pattern}`);
	await pipe(
		["tar", ...TAR_FLAGS, "-C", join(home, ".omp"), ...excludes, "-cf", "-", "agent", "plugins"],
		["docker", "exec", "-i", container, "tar", "-xf", "-", "-C", join(home, ".omp")],
	);
}

export async function copyAgentDb(container: string, home: string): Promise<TableCheck[]> {
	const target = join(home, ".omp", "agent", "agent.db");
	const image = snapshot(target);
	await must(["docker", "exec", "-i", container, "bun", "/sandbox/db.ts", "in", target], image);
	const copy = await mustBytes(["docker", "exec", container, "bun", "/sandbox/db.ts", "out", target]);
	return compareImages(image, copy);
}

export async function copyClaude(container: string, home: string): Promise<string[]> {
	const items = ["rules", "skills", "CLAUDE.md"].filter((item) => existsSync(join(home, ".claude", item)));
	if (items.length === 0) return items;
	await pipe(
		["tar", ...TAR_FLAGS, "-C", join(home, ".claude"), "-cf", "-", ...items],
		["docker", "exec", "-i", container, "tar", "-xf", "-", "-C", join(home, ".claude")],
	);
	return items;
}

export async function copyRepo(container: string, repo: string): Promise<number> {
	const listed = (await must(["git", "-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0");
	const files = listed.filter((file) => file !== "" && existsSync(join(repo, file)));
	await pipe(
		["tar", ...TAR_FLAGS, "-C", repo, "--null", "-T", "-", "-cf", "-"],
		["docker", "exec", "-i", container, "tar", "-xf", "-", "-C", "/repo"],
		`${files.join("\0")}\0`,
	);
	return files.length;
}

export async function installOmp(container: string, home: string): Promise<{ readonly version: string; readonly autoupdate: string }> {
	await must(["docker", "exec", "-w", join(home, ".omp", "plugins"), container, "bun", "install"]);
	await must(["docker", "exec", container, "bun", "install", "-g", "@oh-my-pi/pi-coding-agent"]);
	await must([
		"docker",
		"exec",
		"-w",
		"/repo",
		container,
		"bun",
		"agent/extensions/omp-config-autoupdate/omp-config-update.ts",
		"apply",
		"--source",
		"/repo",
	]);
	const autoupdate = (await must(["docker", "exec", container, "bun", "/sandbox/autoupdate-off.ts"])).trim();
	return { version: (await must(["docker", "exec", container, "omp", "--version"])).trim(), autoupdate };
}

export async function setUpTarget(
	container: string,
	home: string,
	target: string,
	labels: readonly string[],
	network: string,
): Promise<void> {
	await must(["docker", "pull", "-q", "--platform", PLATFORM, TARGET_IMAGE]);
	await must([
		"docker",
		"run",
		"-d",
		"--init",
		"--name",
		target,
		"--hostname",
		target,
		...labels,
		"--network",
		network,
		"--platform",
		PLATFORM,
		TARGET_IMAGE,
		"sleep",
		"infinity",
	]);
	await must([
		"docker",
		"exec",
		target,
		"sh",
		"-c",
		"apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server python3 >/dev/null && mkdir -p /run/sshd && /usr/sbin/sshd",
	]);
	await must([
		"docker",
		"exec",
		container,
		"sh",
		"-c",
		'umask 077 && mkdir -p "$HOME/.ssh" && ssh-keygen -q -t ed25519 -N "" -f "$HOME/.ssh/id_ed25519"',
	]);
	const publicKey = await must(["docker", "exec", container, "sh", "-c", 'cat "$HOME/.ssh/id_ed25519.pub"']);
	await must(
		[
			"docker",
			"exec",
			"-i",
			target,
			"sh",
			"-c",
			"mkdir -p -m 700 /root/.ssh && cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
		],
		publicKey,
	);
	// ssh reads ~/.ssh from the passwd home (/root), not $HOME, so the alias lives in the system config.
	// `docker exec` runs with umask 0, and ssh refuses a group- or world-writable config file.
	await must(
		["docker", "exec", "-i", container, "sh", "-c", "umask 022 && cat > /etc/ssh/ssh_config.d/omp-sandbox-target.conf"],
		`Host target\n\tHostName ${target}\n\tUser root\n\tIdentityFile ${home}/.ssh/id_ed25519\n\tUserKnownHostsFile ${home}/.ssh/known_hosts\n\tStrictHostKeyChecking accept-new\n`,
	);
}
