/**
 * hal-id: #HAL-20261013-0201-DL-PI
 * Tests for lighthal.ts. Black-box: spawns the script and asserts on exit code +
 * JSON stdout, since main() calls process.exit directly.
 *
 * Fully offline: the "GitHub" remotes are local bare repos reached through
 * LIGHTHAL_REMOTE_BASE=file://…, and `claude` is a fake script that prints the
 * real CLI's launch lines wrapped in ANSI codes (so the pty log parse is tested
 * against the same noise the real CLI produces). No cloud session is ever created.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `${import.meta.dir}/lighthal.ts`;
const ROOT = mkdtempSync(join(tmpdir(), "lighthal-test-"));
const REMOTES = join(ROOT, "remotes");
const BARE = join(REMOTES, "acme", "demo.git");
const SEED = join(ROOT, "seed");
const FAKE_CLAUDE = join(ROOT, "fake-claude.sh");
const FAKE_OUT = join(ROOT, "fake-prompt.txt");

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function sh(cmd: string[], cwd?: string) {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0)
		throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}
const git = (cwd: string, ...args: string[]) =>
	sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd);

// One bare "GitHub" repo with a main branch.
mkdirSync(join(REMOTES, "acme"), { recursive: true });
sh(["git", "init", "-q", "--bare", "-b", "main", BARE]);
sh(["git", "init", "-q", "-b", "main", SEED]);
writeFileSync(join(SEED, "README.md"), "demo\n");
git(SEED, "add", ".");
git(SEED, "commit", "-q", "-m", "init");
git(SEED, "remote", "add", "origin", BARE);
git(SEED, "push", "-q", "origin", "main");

// A second repo, to prove the one pad switches cleanly between repos.
const OTHER_BARE = join(REMOTES, "acme", "other.git");
const OTHER_SEED = join(ROOT, "other-seed");
sh(["git", "init", "-q", "--bare", "-b", "main", OTHER_BARE]);
sh(["git", "init", "-q", "-b", "main", OTHER_SEED]);
writeFileSync(join(OTHER_SEED, "OTHER.md"), "other\n");
git(OTHER_SEED, "add", ".");
git(OTHER_SEED, "commit", "-q", "-m", "other init");
git(OTHER_SEED, "remote", "add", "origin", OTHER_BARE);
git(OTHER_SEED, "push", "-q", "origin", "main");
const DEMO_INIT = git(SEED, "rev-list", "--max-parents=0", "HEAD");

// Fake claude: records the prompt it was given, then behaves per FAKE_MODE.
writeFileSync(
	FAKE_CLAUDE,
	`#!/usr/bin/env bash
[ "$1" = "--cloud" ] || { echo "fake: expected --cloud" >&2; exit 9; }
printf '%s' "$2" > "$FAKE_OUT"
case "\${FAKE_MODE:-ok}" in
  ok)    printf '\\033[?25l\\033[1mCreated cloud session:\\033[0m demo\\r\\nView: https://claude.ai/code/session_01FakeSession42?from=cli&m=0\\r\\nResume with: claude --teleport session_01FakeSession42\\r\\n' ;;
  noid)  printf 'Something changed in the CLI\\r\\n' ;;
  trust) printf 'Quick\\033[1Csafety\\033[1Ccheck: Is this a project you trust?\\r\\n\\xe2\\x9d\\xaf No, exit\\r\\n  Yes, I trust this folder\\r\\n'; sleep 30 ;;
esac
`,
);
chmodSync(FAKE_CLAUDE, 0o755);

function run(
	args: string[],
	extraEnv: Record<string, string> = {},
	home = join(ROOT, "home"),
) {
	const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
		env: {
			...process.env,
			LIGHTHAL_HOME: home,
			LIGHTHAL_OWNER: "acme",
			LIGHTHAL_DEFAULT_REPO: "",
			LIGHTHAL_AUTHOR: "",
			LIGHTHAL_REMOTE_BASE: `file://${REMOTES}`,
			LIGHTHAL_CLAUDE_BIN: FAKE_CLAUDE,
			LIGHTHAL_LAUNCH_TIMEOUT_S: "5",
			FAKE_OUT,
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = r.stdout.toString();
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(stdout);
	} catch {
		/* non-JSON output: assertions on json fail loudly */
	}
	return { code: r.exitCode, json, stdout, stderr: r.stderr.toString() };
}

const startOk = (task = "write hello.md", home?: string) =>
	run(["start", "--repo", "acme/demo", "--task", task], {}, home);

/** Push a branch to the bare repo as the cloud session would. */
function cloudPush(
	branch: string,
	commits: { subject: string; body?: string; file?: string }[],
) {
	const w = mkdtempSync(join(ROOT, "cloud-"));
	sh(["git", "clone", "-q", BARE, w]);
	git(w, "checkout", "-q", "-b", branch);
	for (const c of commits) {
		if (c.file) {
			writeFileSync(join(w, c.file), `${c.subject}\n`);
			git(w, "add", c.file);
		}
		git(
			w,
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			c.subject,
			...(c.body ? ["-m", c.body] : []),
		);
	}
	git(w, "push", "-q", "-f", "origin", branch);
}

describe("config", () => {
	test("refuses to start with no owner configured", () => {
		const home = mkdtempSync(join(ROOT, "home-nocfg-"));
		const r = run(
			["start", "--repo", "demo", "--task", "x"],
			{ LIGHTHAL_OWNER: "" },
			home,
		);
		expect(r.code).toBe(1);
		expect(String(r.json.error)).toContain("config.json");
	});

	test("reads owner, default repo and author from config.json", () => {
		const home = mkdtempSync(join(ROOT, "home-cfg-"));
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({
				owner: "acme",
				defaultRepo: "demo",
				author: "Test Person <t@example.com>",
			}),
		);
		const r = run(["start", "--task", "x"], { LIGHTHAL_OWNER: "" }, home);
		expect(r.code).toBe(0);
		expect(r.json.repo).toBe("acme/demo");
		expect(readFileSync(FAKE_OUT, "utf8")).toContain(
			"Use the author Test Person <t@example.com>",
		);
	});

	test("leaves the author line out when no author is configured", () => {
		const r = startOk();
		expect(r.code).toBe(0);
		const prompt = readFileSync(FAKE_OUT, "utf8");
		expect(prompt).not.toContain("Use the author");
		expect(prompt).toContain("3. Push to your own claude/* branch only");
	});

	test("refuses a repo the Claude GitHub App is not installed on (appRepos)", () => {
		// Without the app, claude --cloud uploads the pad as a bundle and the session cannot push its branch.
		const r = run(["start", "--repo", "acme/demo", "--task", "x"], {
			LIGHTHAL_APP_REPOS: "other,vault",
		});
		expect(r.code).toBe(1);
		expect(String(r.json.error)).toContain("Claude GitHub App");
		expect(String(r.json.error)).toContain("appRepos");
	});

	test("starts on a repo listed in appRepos (config.json)", () => {
		const home = mkdtempSync(join(ROOT, "home-app-"));
		writeFileSync(
			join(home, "config.json"),
			JSON.stringify({ owner: "acme", appRepos: ["demo"] }),
		);
		const r = run(
			["start", "--repo", "acme/demo", "--task", "x"],
			{ LIGHTHAL_OWNER: "" },
			home,
		);
		expect(r.code).toBe(0);
	});

	test("refuses a missing repo when no default is configured", () => {
		const r = run(["start", "--task", "x"]);
		expect(r.code).toBe(1);
		expect(String(r.json.error)).toContain("no repo");
	});
});

describe("start: input checks", () => {
	test("refuses a repo outside the configured owner", () => {
		const r = run([
			"start",
			"--repo",
			"someone-else/their-repo",
			"--task",
			"x",
		]);
		expect(r.code).toBe(1);
		expect(String(r.json.error)).toContain("acme");
	});

	test("refuses path traversal in the repo name", () => {
		for (const bad of ["acme/..", "acme/.", "acme/demo.git", "acme/a/b"]) {
			const r = run(["start", "--repo", bad, "--task", "x"]);
			expect(r.code).toBe(1);
		}
	});

	test("refuses when no task is given", () => {
		const r = run(["start", "--repo", "acme/demo"]);
		expect(r.code).toBe(1);
		expect(String(r.json.error)).toContain("task");
	});

	test("refuses a base branch that does not exist", () => {
		const r = run([
			"start",
			"--repo",
			"acme/demo",
			"--base",
			"nope",
			"--task",
			"x",
		]);
		expect(r.code).toBe(1);
	});

	test("refuses a task carrying a secret, before any launch", () => {
		if (existsSync(FAKE_OUT)) rmSync(FAKE_OUT);
		// Fake credentials, assembled at run time so this file itself holds no
		// secret-shaped literal (the vault's gitleaks pre-commit hook would block it).
		const awsKey = ["AK", "IA", "IOSFODNN7EXAMPL3"].join("");
		const ghToken = ["gh", "p_", "016IJ9d7lAbcDeFgHiJkLmNoPqRsTuVwXyZ0"].join(
			"",
		);
		const r = run([
			"start",
			"--repo",
			"acme/demo",
			"--task",
			`use key ${awsKey} and token ${ghToken}`,
		]);
		expect(r.code).toBe(4);
		expect(existsSync(FAKE_OUT)).toBe(false);
	});

	test("refuses a prompt over 100 KB", () => {
		const r = run([
			"start",
			"--repo",
			"acme/demo",
			"--task",
			"a".repeat(101 * 1024),
		]);
		expect(r.code).toBe(1);
	});

	test("refuses while another start holds the repo lock", () => {
		const home = mkdtempSync(join(ROOT, "home-lock-"));
		mkdirSync(join(home, "locks"), { recursive: true });
		writeFileSync(join(home, "locks", "pad.lock"), String(process.pid));
		const r = startOk("x", home);
		expect(r.code).toBe(1);
		expect(String(r.json.error)).toContain("busy");
	});
});

describe("start: launch", () => {
	test("parses the session id through ANSI noise and records state", () => {
		const r = startOk();
		expect(r.code).toBe(0);
		expect(String(r.json.ticket)).toMatch(/^lh-\d{8}-\d{6}-[a-z0-9]{6}$/);
		expect(r.json.session).toBe("session_01FakeSession42");
		expect(String(r.json.sessionUrl)).toContain(
			"claude.ai/code/session_01FakeSession42",
		);
		const state = join(ROOT, "home", "state", `${r.json.ticket}.json`);
		expect(existsSync(state)).toBe(true);
	});

	test("passes hostile task text through verbatim and runs none of it", () => {
		const pwned = join(ROOT, "PWNED");
		const task = `fix the "login" 'README'\nline two $(touch ${pwned}) \`touch ${pwned}\` $HOME`;
		const r = startOk(task);
		expect(r.code).toBe(0);
		const prompt = readFileSync(FAKE_OUT, "utf8");
		expect(prompt.startsWith(task)).toBe(true);
		expect(prompt).toContain(`lightHAL ${r.json.ticket} done`);
		expect(existsSync(pwned)).toBe(false);
	});

	test("empties the pad before every launch", () => {
		startOk();
		const stray = join(ROOT, "home", "pad", "stray.txt");
		writeFileSync(stray, "left behind\n");
		const r = startOk();
		expect(r.code).toBe(0);
		expect(existsSync(stray)).toBe(false);
	});

	test("no session id in the CLI output is a launch failure", () => {
		const r = run(["start", "--repo", "acme/demo", "--task", "x"], {
			FAKE_MODE: "noid",
		});
		expect(r.code).toBe(3);
		expect(String(r.json.logTail)).toContain("Something changed");
	});

	test("an untrusted folder is reported as a trust problem, not a hang", () => {
		const r = run(["start", "--repo", "acme/demo", "--task", "x"], {
			FAKE_MODE: "trust",
			LIGHTHAL_LAUNCH_TIMEOUT_S: "2",
		});
		expect(r.code).toBe(3);
		expect(String(r.json.error)).toContain("trust");
	});
});

describe("one pad for every repo", () => {
	test("switching repos leaves no history of the previous one", () => {
		expect(startOk().code).toBe(0);
		const r = run(["start", "--repo", "acme/other", "--task", "x"]);
		expect(r.code).toBe(0);
		const pad = join(ROOT, "home", "pad");
		expect(git(pad, "remote", "get-url", "origin")).toBe(
			`file://${OTHER_BARE}`,
		);
		const has = Bun.spawnSync(["git", "cat-file", "-e", DEMO_INIT], {
			cwd: pad,
		});
		expect(has.exitCode).not.toBe(0);
	});

	test("wait still works after the pad moved on to another repo", () => {
		const s = startOk();
		const t = String(s.json.ticket);
		expect(run(["start", "--repo", "acme/other", "--task", "x"]).code).toBe(0);
		cloudPush(`claude/${t}-gh78`, [
			{ subject: `lightHAL ${t}: add late.md`, file: "late.md" },
			{ subject: `lightHAL ${t} done`, body: "done after the pad moved" },
		]);
		const r = run(["wait", t, "--interval-s", "1", "--timeout-min", "0.2"]);
		expect(r.code).toBe(0);
		expect(r.json.files).toEqual(["late.md"]);
	});
});

describe("wait", () => {
	test("finds the done commit, its summary and the work files", () => {
		const s = startOk();
		const t = String(s.json.ticket);
		cloudPush(`claude/${t}-ab12`, [
			{ subject: `lightHAL ${t}: add hello`, file: "hello.md" },
			{ subject: `lightHAL ${t} done`, body: "Wrote hello.md.\nTests: 1 pass" },
		]);
		const r = run(["wait", t, "--interval-s", "1", "--timeout-min", "0.2"]);
		expect(r.code).toBe(0);
		expect(r.json.branch).toBe(`claude/${t}-ab12`);
		expect(String(r.json.summary)).toContain("Tests: 1 pass");
		expect(r.json.files).toEqual(["hello.md"]);
		expect(r.json.descendsFromBase).toBe(true);
		expect((r.json.workCommits as unknown[]).length).toBe(1);
	});

	test("a ticket without done is in progress; times out with a resume command", () => {
		const s = startOk();
		const t = String(s.json.ticket);
		cloudPush("claude/unrelated-zz99", [
			{ subject: "some other job", file: "other.md" },
		]);
		cloudPush(`claude/${t}-cd34`, [
			{ subject: `lightHAL ${t}: halfway`, file: "half.md" },
		]);
		const r = run(["wait", t, "--interval-s", "1", "--timeout-min", "0.05"]);
		expect(r.code).toBe(2);
		expect(r.json.inProgress).toEqual([`claude/${t}-cd34`]);
		expect(String(r.json.resume)).toContain(`wait ${t}`);
		expect(String(r.json.teleport)).toContain("session_01FakeSession42");
	});

	test("warns when a non-claude branch moved during the job", () => {
		const s = startOk();
		const t = String(s.json.ticket);
		writeFileSync(join(SEED, "main-moved.md"), "x\n");
		git(SEED, "add", ".");
		git(SEED, "commit", "-q", "-m", "someone moved main");
		git(SEED, "push", "-q", "origin", "main");
		cloudPush(`claude/${t}-ef56`, [
			{ subject: `lightHAL ${t} done`, body: "nothing to do" },
		]);
		const r = run(["wait", t, "--interval-s", "1", "--timeout-min", "0.2"]);
		expect(r.code).toBe(0);
		expect(JSON.stringify(r.json.warnings)).toContain("refs/heads/main");
	});

	test("unknown ticket is an input error", () => {
		const r = run(["wait", "lh-20000101-000000-aaaaaa"]);
		expect(r.code).toBe(1);
	});
});

describe("status", () => {
	test("lists tickets", () => {
		const r = run(["status"]);
		expect(r.code).toBe(0);
		expect(Array.isArray(r.json.tickets)).toBe(true);
		expect((r.json.tickets as unknown[]).length).toBeGreaterThan(0);
	});
});
