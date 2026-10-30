// tool-policy-nag pty lane: every registry rule has one command (or cell) it
// refuses and its closest one it lets through; the structural cases pin what
// the lane reads (pipelines, wrappers, loops, `&`, eval launches) and where it
// fails open.
import { describe, expect, test } from "bun:test";
import { type PtyRuleId, ptyEvalHit, ptyRefusal, ptyShellHit } from "../agent/extensions/tool-policy-nag/pty.ts";

type Probe = { readonly shell: string } | { readonly py: string };

const FIXTURES: Record<PtyRuleId, { readonly hit: Probe; readonly miss: Probe }> = {
	ssh: { hit: { shell: "ssh -o BatchMode=yes host 'cat /etc/hosts'" }, miss: { shell: "ssh -G host" } },
	mosh: { hit: { shell: "mosh host" }, miss: { shell: "moshi host" } },
	vagrantSsh: { hit: { shell: "vagrant ssh default" }, miss: { shell: "vagrant status" } },
	gcloudSsh: { hit: { shell: "gcloud --project p compute ssh vm" }, miss: { shell: "gcloud compute instances list" } },
	ssmSession: { hit: { shell: "aws ssm start-session --target i-1" }, miss: { shell: "aws ssm describe-sessions" } },
	containerExec: { hit: { shell: "docker -H tcp://h exec app sh" }, miss: { shell: "docker cp app:/f ." } },
	composeExec: { hit: { shell: "docker compose -f c.yml exec web sh" }, miss: { shell: "docker compose ps" } },
	kubectlExec: { hit: { shell: "kubectl --context c -n x exec p -- ls" }, miss: { shell: "kubectl cp p:/f f" } },
	incusExec: { hit: { shell: "incus exec c1 -- ls" }, miss: { shell: "incus list" } },
	pctExec: { hit: { shell: "pct enter 171" }, miss: { shell: "pct list" } },
	qmGuest: { hit: { shell: "qm guest exec 111 -- ls" }, miss: { shell: "qm guest cmd 111 ping" } },
	orbShell: { hit: { shell: "orb -m box -u root ls" }, miss: { shell: "orb list" } },
	limaShell: { hit: { shell: "limactl shell default" }, miss: { shell: "limactl list" } },
	multipassExec: { hit: { shell: "multipass exec vm -- ls" }, miss: { shell: "multipass list" } },
	distroboxEnter: { hit: { shell: "distrobox enter box" }, miss: { shell: "distrobox list" } },
	nsenter: { hit: { shell: "nsenter -t 1 -m ls" }, miss: { shell: "lsns" } },
	su: { hit: { shell: "su - postgres" }, miss: { shell: "sum f" } },
	shellString: { hit: { shell: "bash -lc 'ls'" }, miss: { shell: "bash script.sh" } },
	powershellCommand: { hit: { shell: "pwsh -NoProfile -Command Get-Date" }, miss: { shell: "pwsh -File x.ps1" } },
	repl: { hit: { shell: "python3 -q" }, miss: { shell: "python3 x.py" } },
	psql: { hit: { shell: "psql -h db -U app app" }, miss: { shell: "psql -h db -c 'select 1'" } },
	mysql: { hit: { shell: "mysql -u root shop" }, miss: { shell: "mysql -u root -e 'select 1' shop" } },
	redisCli: { hit: { shell: "redis-cli -h cache" }, miss: { shell: "redis-cli -h cache ping" } },
	sqlite3: { hit: { shell: "sqlite3 app.db" }, miss: { shell: "sqlite3 app.db 'select 1'" } },
	mongosh: { hit: { shell: "mongosh mongodb://db/app" }, miss: { shell: "mongosh mongodb://db/app --eval 'db.x.count()'" } },
	editor: { hit: { shell: "vim notes.txt" }, miss: { shell: "emacs --batch -l x.el" } },
	tui: { hit: { shell: "top -o cpu" }, miss: { shell: "top -b -n 1" } },
	gitInteractive: { hit: { shell: "git -C repo commit -a" }, miss: { shell: "git -C repo commit -am 'msg'" } },
	fakeTerminal: { hit: { shell: "script -q /dev/null ls" }, miss: { shell: "scriptreplay t" } },
	elevation: { hit: { shell: "sudo -u root ls" }, miss: { shell: "sudo -Sn ls" } },
	passwd: { hit: { shell: "passwd" }, miss: { shell: "pwd" } },
	ghAuthLogin: { hit: { shell: "gh auth login --web" }, miss: { shell: "gh auth login --with-token" } },
	pexpect: { hit: { py: "import pexpect\npexpect.spawn('ssh h')" }, miss: { py: "expect = 1\nprint(expect)" } },
	ptySpawn: { hit: { py: "import pty\npty.spawn(['bash'])" }, miss: { py: "import pty\nprint(pty.STDIN_FILENO)" } },
	tailFollow: { hit: { shell: "tail -n 5 -F app.log" }, miss: { shell: "tail -n 5 app.log" } },
	journalFollow: { hit: { shell: "journalctl -u nginx -f" }, miss: { shell: "journalctl -u nginx -n 50" } },
	containerLogsFollow: { hit: { shell: "docker logs -f app" }, miss: { shell: "docker logs --tail 50 app" } },
	composeLogsFollow: { hit: { shell: "docker compose logs --follow web" }, miss: { shell: "docker compose logs web" } },
	composeUp: { hit: { shell: "docker-compose up web" }, miss: { shell: "docker compose up -d web" } },
	kubectlLogsFollow: { hit: { shell: "kubectl -n x logs -f p" }, miss: { shell: "kubectl -n x logs --tail 20 p" } },
	kubectlWatch: { hit: { shell: "kubectl get pods -w" }, miss: { shell: "kubectl get pods -o wide" } },
	watch: { hit: { shell: "watch -n 1 date" }, miss: { shell: "date" } },
	ghRunWatch: { hit: { shell: "gh run watch 123" }, miss: { shell: "gh run view 123" } },
	ping: { hit: { shell: "ping example.com" }, miss: { shell: "ping -c 3 example.com" } },
	detach: { hit: { shell: "nohup ./server" }, miss: { shell: "./server --check" } },
	background: { hit: { shell: "make serve &" }, miss: { shell: "make build && make test" } },
	loopSleep: { hit: { shell: "until curl -fs localhost; do sleep 2; done" }, miss: { shell: "sleep 2 && curl -fs localhost" } },
};

const probe = (input: Probe) => ("shell" in input ? Promise.resolve(ptyShellHit(input.shell)) : ptyEvalHit("py", input.py));

describe("pty rule registry", () => {
	for (const [rule, { hit, miss }] of Object.entries(FIXTURES)) {
		test(`${rule} refuses its hit`, async () => {
			expect<string | undefined>((await probe(hit))?.rule).toBe(rule);
		});
		test(`${rule} lets its miss through`, async () => {
			expect(await probe(miss)).toBeNull();
		});
	}
});

describe("pty shell structure", () => {
	const ruleOf = (line: string): string | null => ptyShellHit(line)?.rule ?? null;

	test("any simple command of the line decides: pipelines, substitutions, chains, wrappers", () => {
		expect(ruleOf("echo x | ssh host cat")).toBe("ssh");
		expect(ruleOf("echo $(docker exec app cat /f)")).toBe("containerExec");
		expect(ruleOf("true && false || zsh -c 'x'")).toBe("shellString");
		expect(ruleOf("env A=1 timeout 5 nice -n 5 stdbuf -oL tail -f log")).toBe("tailFollow");
		expect(ruleOf("nohup sleep 100")).toBe("detach");
	});

	test("the first hit in source order names the rule", () => {
		expect(ptyShellHit("sudo ls; ssh host true")?.category).toBe("terminal");
		expect(ptyShellHit("ssh host true & sleep 1")?.rule).toBe("ssh");
	});

	test("a non-interactive sudo is judged by the command it runs", () => {
		expect(ruleOf("sudo -n ssh host true")).toBe("ssh");
		expect(ruleOf("sudo -n systemctl status x")).toBeNull();
	});

	test("only a lone & backgrounds; && and redirections do not", () => {
		expect(ruleOf("sleep 1 & echo next")).toBe("background");
		expect(ruleOf("make 2>&1 && echo ok")).toBeNull();
		expect(ruleOf("make &> log")).toBeNull();
	});

	test("sleep counts in a loop body, not in its condition nor after done", () => {
		expect(ruleOf("for i in 1 2; do echo $i; sleep 1; done")).toBe("loopSleep");
		expect(ruleOf("while sleep 1; do echo x; done")).toBeNull();
		expect(ruleOf("for i in 1 2; do echo $i; done; sleep 1")).toBeNull();
		expect(ruleOf("echo done; sleep 1")).toBeNull();
	});

	test("a piped or redirected REPL is not interactive", () => {
		expect(ruleOf("echo 'print(1)' | python3")).toBeNull();
		expect(ruleOf("python3 < x.py")).toBeNull();
		expect(ruleOf("sqlite3 app.db <<'EOF'\nselect 1;\nEOF")).toBeNull();
	});

	test("unknown programs and unterminated lines pass", () => {
		expect(ruleOf("$REMOTE host true")).toBeNull();
		expect(ruleOf("ssh host 'unterminated")).toBeNull();
		expect(ruleOf("ls | xargs -I{} sh -c 'echo {}'")).toBeNull();
		expect(ruleOf("find . -exec sh -c 'true' \\;")).toBeNull();
		expect(ruleOf("eval 'ssh host'")).toBeNull();
	});
});

describe("pty eval cells", () => {
	const pyRule = async (code: string) => (await ptyEvalHit("py", code))?.rule ?? null;
	const jsRule = async (code: string) => (await ptyEvalHit("js", code))?.rule ?? null;

	test("py launches spelled under their own names with literal arguments", async () => {
		expect(await pyRule('import subprocess\nsubprocess.run(["ssh", "host", "true"])\nprint(1)')).toBe("ssh");
		expect(await pyRule('import subprocess\nsubprocess.check_output("tail -f log", shell=True)')).toBe("tailFollow");
		expect(await pyRule('import os\nos.system("zsh -c true")')).toBe("shellString");
		expect(await pyRule('from subprocess import Popen\nPopen(["python3"])')).toBe("repl");
		expect(await pyRule("x = 1\n!ssh host true")).toBe("ssh");
		expect(await pyRule("%%bash\nwatch date")).toBe("watch");
	});

	test("py aliases, variables, f-strings and untokenizable cells pass", async () => {
		expect(await pyRule('import subprocess as sp\nsp.run(["ssh", "host"])')).toBeNull();
		expect(await pyRule('from os import system as sh\nsh("ssh host")')).toBeNull();
		expect(await pyRule('import subprocess\ncmd = ["ssh", "h"]\nsubprocess.run(cmd)')).toBeNull();
		expect(await pyRule('import subprocess\nh = "x"\nsubprocess.run(["ssh", h])')).toBeNull();
		expect(await pyRule('import os\nh = "x"\nos.system(f"ssh {h}")')).toBeNull();
		expect(await pyRule('import subprocess\nsubprocess.run(["ssh", "h"]')).toBeNull();
		expect(await pyRule('tool.bash({"command": "ssh host"})')).toBeNull();
	});

	test("js launches spelled under their own names with literal arguments", async () => {
		expect(await jsRule("await Bun.$`ssh host true`.nothrow();")).toBe("ssh");
		expect(await jsRule('Bun.spawnSync(["kubectl", "logs", "-f", "p"]);')).toBe("kubectlLogsFollow");
		expect(await jsRule('import { execSync } from "node:child_process";\nexecSync("docker exec app ls");')).toBe("containerExec");
		expect(await jsRule('require("child_process").spawn("ssh", ["host"]);')).toBe("ssh");
		expect(await jsRule('import { spawnSync } from "child_process";\nspawnSync("tail", ["-f", "x"], { shell: true });')).toBe("tailFollow");
	});

	test("js aliases, interpolation, bridges and unparsable cells pass", async () => {
		expect(await jsRule('import { execSync as run } from "child_process";\nrun("ssh host");')).toBeNull();
		expect(await jsRule('const cp = require("child_process");\ncp.execSync("ssh host");')).toBeNull();
		expect(await jsRule("const h = 'x';\nawait Bun.$`ssh $" + "{h} true`;")).toBeNull();
		expect(await jsRule('await tool.bash({ command: "ssh host" });')).toBeNull();
		expect(await jsRule("Bun.$`ssh host`(")).toBeNull();
	});
});

describe("pty refusal", () => {
	test("names the category, the program, the destination and the category's rewrite", () => {
		const passthrough = ptyShellHit("zsh -c 'true'");
		const terminal = ptyShellHit("python3");
		const openEnded = ptyShellHit("tail -f log");
		if (passthrough === null || terminal === null || openEnded === null) throw new Error("fixture lines must hit");
		const shown = ptyRefusal(passthrough, "bash", "zsh -c 'true'", "sh");
		for (const part of ["passthrough", "`zsh`", "xd://exec_command", "<<'EOF'", "write_stdin", "`shell`", "ssh://", "zsh -c 'true'"])
			expect(shown).toContain(part);
		expect(ptyRefusal(terminal, "bash", "python3", "sh")).toContain("terminal");
		expect(ptyRefusal(openEnded, "bash", "tail -f log", "sh")).toContain("monitor");
	});
});
