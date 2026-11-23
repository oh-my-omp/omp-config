import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { compareImages, snapshot, type TableCheck } from "./agentdb.ts";
import { must, mustBytes, pipe, run } from "./docker.ts";

export const IMAGE = "oven/bun:latest";
export const TARGET_IMAGE = "debian:stable-slim";
export const PLATFORM = "linux/arm64";
const TAR_FLAGS = ["--no-xattrs", "--no-mac-metadata"];

// Every updater-managed plain file must stay excluded: without `.omp-config-base/files`, a host copy is an
// `unknown-base` conflict and the updater keeps it instead of writing the `/repo` version.
const AGENT_EXCLUDES = [
	"agent/sessions",
	"agent/blobs",
	"agent/terminal-sessions",
	"agent/custom-session-files",
	"agent/predict",
	"agent/cache",
	"agent/history.db*",
	"agent/agent.db*",
	"agent/models.db*",
	"agent/transcripts.db*",
	"agent/skill-descriptions.db*",
	"agent/models.yml.bak*",
	"agent/rules",
	"agent/mcp.json*",
	"agent/extensions",
	"agent/extensions-last",
	"agent/agents",
	"agent/SYSTEM_TEMPLATE.md",
	"agent/APPEND_SYSTEM*.md",
	"agent/PERSONALITY.md",
	"agent/config-light.yml",
	"agent/omp-light.ts",
	"agent/.omp-config-base/files",
	"agent/*.lock",
	"plugins/node_modules",
];

const EXCLUDED_PLUGINS = ["omp-remote-build"];

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
	const statePath = join(home, ".omp", "agent", ".omp-config-base", "state.json");
	await must([
		"docker",
		"exec",
		container,
		"bun",
		"-e",
		'import { existsSync, readFileSync, writeFileSync } from "node:fs"; const p = process.argv[1]; if (p && existsSync(p)) { const s = JSON.parse(readFileSync(p, "utf8")); if (typeof s === "object" && s !== null && !Array.isArray(s)) { s.unknownPlain = []; writeFileSync(p, JSON.stringify(s, null, 2) + "\\n"); } }',
		"--",
		statePath,
	]);
	await must([
		"docker",
		"exec",
		container,
		"bun",
		"-e",
		'import { existsSync, readFileSync, writeFileSync } from "node:fs"; const [dir, ...names] = process.argv.slice(1); for (const [file, key] of [["package.json", "dependencies"], ["omp-plugins.lock.json", "plugins"]]) { const p = dir + "/" + file; if (!existsSync(p)) continue; const j = JSON.parse(readFileSync(p, "utf8")); for (const name of names) delete j[key]?.[name]; writeFileSync(p, JSON.stringify(j, null, 2) + "\\n"); }',
		"--",
		join(home, ".omp", "plugins"),
		...EXCLUDED_PLUGINS,
	]);
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
	await must([
		"docker",
		"exec",
		container,
		"sh",
		"-c",
		"git -C /repo init -q -b main && git -C /repo config user.email sandbox@local && git -C /repo config user.name sandbox && git -C /repo add -A && git -C /repo commit -q -m sandbox --allow-empty",
	]);
	return files.length;
}

async function linkPlugin(container: string, pluginDir: string): Promise<string> {
	if (!existsSync(pluginDir)) throw new Error(`plugin directory does not exist: ${pluginDir}`);
	const dest = join("/plugins", basename(pluginDir));
	await must(["docker", "exec", container, "mkdir", "-p", dest]);
	const listed = await run(["git", "-C", pluginDir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	if (listed.code === 0) {
		const files = listed.stdout.split("\0").filter((file) => file !== "" && existsSync(join(pluginDir, file)));
		if (files.length > 0) {
			await pipe(
				["tar", ...TAR_FLAGS, "-C", pluginDir, "--null", "-T", "-", "-cf", "-"],
				["docker", "exec", "-i", container, "tar", "-xf", "-", "-C", dest],
				`${files.join("\0")}\0`,
			);
		}
	} else {
		await pipe(
			["tar", ...TAR_FLAGS, "-C", pluginDir, "--exclude=node_modules", "--exclude=.git", "-cf", "-", "."],
			["docker", "exec", "-i", container, "tar", "-xf", "-", "-C", dest],
		);
	}
	if ((await run(["docker", "exec", container, "test", "-f", join(dest, "package.json")])).code === 0) {
		await must(["docker", "exec", "-w", dest, container, "bun", "install"]);
	}
	await must(["docker", "exec", container, "omp", "plugin", "link", dest]);
	return dest;
}

export async function installOmp(
	container: string,
	home: string,
	plugins: readonly string[] = [],
): Promise<{ readonly version: string; readonly autoupdate: string; readonly linked: readonly string[] }> {
	const pluginsDir = join(home, ".omp", "plugins");
	const installed = await run(["docker", "exec", "-w", pluginsDir, container, "bun", "install"]);
	if (installed.code !== 0) {
		await must(["docker", "exec", container, "rm", "-f", join(pluginsDir, "bun.lock")]);
		await must(["docker", "exec", "-w", pluginsDir, container, "bun", "install"]);
	}
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
	const linked: string[] = [];
	for (const pluginDir of plugins) linked.push(await linkPlugin(container, pluginDir));
	return { version: (await must(["docker", "exec", container, "omp", "--version"])).trim(), autoupdate, linked };
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
