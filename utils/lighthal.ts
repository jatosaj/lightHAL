#!/usr/bin/env bun
/**
 * hal-id: #HAL-20261013-0200-DL-IK
 *
 * lightHAL: hand a task to a NEW Claude cloud session and collect its result
 * from GitHub. `start` launches the session with the task as its first prompt
 * (plus a footer that tells it how to report back), `wait` polls the repo's
 * claude/* branches until the session's "done" commit appears.
 *
 * Usage:
 *   lighthal.ts start [--repo <owner>/<name>] [--base main] (--task "..." | --task-file f)
 *   lighthal.ts wait <ticket> [--timeout-min 60] [--interval-s 30]
 *   lighthal.ts status [ticket]
 *
 * How it reports back: the session commits its work ("lightHAL <ticket>: ...")
 * and ends with an EMPTY commit "lightHAL <ticket> done" whose body is the
 * summary, then pushes its own claude/* branch. Cherry-pick the work commits,
 * never the done commit or the whole branch.
 *
 * Config: $LIGHTHAL_HOME/config.json, each key overridable by env:
 *   {"owner": "YOUR-GITHUB-ORG",            LIGHTHAL_OWNER (required): the only
 *                                            GitHub user/org whose repos may be used
 *    "defaultRepo": "YOUR-REPO",            LIGHTHAL_DEFAULT_REPO: used when --repo is omitted
 *    "author": "YOUR NAME <YOUR-EMAIL>",    LIGHTHAL_AUTHOR: commit author the session must use
 *    "appRepos": ["YOUR-REPO"]}             LIGHTHAL_APP_REPOS (comma-separated): repos the Claude GitHub
 *                                            App is installed on; when set, start refuses any other. Without
 *                                            the app, `claude --cloud` uploads the pad as a bundle and the
 *                                            session cannot push its branch (no result ever comes back)
 *
 * Launch rules:
 *   - only repos under the configured owner; never launched from your working
 *     checkout. Every start empties ONE launch folder, $LIGHTHAL_HOME/pad, and
 *     fresh-clones the target repo into it (`claude --cloud` clones the cwd's
 *     remote; a fresh clone carries no other repo's history and no leftovers)
 *   - `claude --cloud` needs a TTY, so it runs under `script`; the prompt
 *     travels in a file, never through a shell string
 *   - the pad must pass Claude Code's workspace-trust prompt once, answered by a
 *     person: `cd $LIGHTHAL_HOME/pad && claude`, pick "Yes, I trust this folder".
 *     Trust is tied to the path, so it survives every re-clone
 *   - one start at a time (a lock held for the ~10 s launch); the sessions
 *     themselves run in parallel. `wait` reads a per-repo bare cache, never the pad
 *   - the prompt is scanned with gitleaks first and capped at 100 KB
 *
 * Env: LIGHTHAL_HOME (default ~/work/lighthal), LIGHTHAL_REMOTE_BASE
 *   (default https://github.com), LIGHTHAL_CLAUDE_BIN (default claude),
 *   LIGHTHAL_GITLEAKS_BIN (default gitleaks), LIGHTHAL_LAUNCH_TIMEOUT_S (120)
 * Needs: bun, git, gitleaks, script (util-linux on Linux; BSD script on macOS),
 *   the claude CLI signed in to claude.ai, GitHub connected for cloud sessions.
 *
 * Output: one JSON object on stdout. Exit codes:
 *   0 - ok (start: session launched · wait: done commit found)
 *   1 - bad input or refused (config, repo, base, task, size, lock busy, clone not clean)
 *   2 - wait timed out (JSON carries the resume and teleport commands)
 *   3 - launch failed (folder not trusted, no session id in the CLI output)
 *   4 - gitleaks found a likely secret in the prompt (nothing was sent)
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

const HOME = process.env.LIGHTHAL_HOME || join(homedir(), "work", "lighthal");
const REMOTE_BASE = process.env.LIGHTHAL_REMOTE_BASE || "https://github.com";
const CLAUDE_BIN = process.env.LIGHTHAL_CLAUDE_BIN || "claude";
const GITLEAKS_BIN = process.env.LIGHTHAL_GITLEAKS_BIN || "gitleaks";
const LAUNCH_TIMEOUT_S = Number(process.env.LIGHTHAL_LAUNCH_TIMEOUT_S || 120);
const MAX_PROMPT_BYTES = 100 * 1024;
const CLAUDE_REF = "refs/heads/claude/";

type Out = Record<string, unknown>;
class Fail extends Error {
	constructor(
		public code: number,
		message: string,
		public extra: Out = {},
	) {
		super(message);
	}
}

interface State {
	ticket: string;
	repo: string;
	url: string;
	cache?: string; // bare cache wait() fetches into
	clone?: string; // older tickets: their per-repo launch clone
	base: string;
	baseCommit: string;
	session: string;
	sessionUrl: string;
	startedAt: string;
	baseline: Record<string, string>;
	status: "started" | "done";
	result?: { branch: string; commit: string };
}

function run(cmd: string[], cwd?: string) {
	const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: r.exitCode,
		out: r.stdout.toString(),
		err: r.stderr.toString().trim(),
	};
}

function git(cwd: string | undefined, ...args: string[]) {
	const r = run(["git", ...args], cwd);
	if (r.code !== 0) throw new Fail(1, `git ${args[0]} failed: ${r.err}`);
	return r.out.trim();
}

function parseArgs(argv: string[]) {
	const flags: Record<string, string> = {};
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith("--"))
				throw new Fail(1, `${a} needs a value`);
			flags[a.slice(2)] = v;
			i++;
		} else positional.push(a);
	}
	return { flags, positional };
}

interface Config {
	owner: string;
	defaultRepo?: string;
	author?: string;
	appRepos?: string[];
}

/** $LIGHTHAL_HOME/config.json, each key overridden by its LIGHTHAL_* env var. */
function loadConfig(): Config {
	const path = join(HOME, "config.json");
	let file: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			file = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new Fail(1, `config is not valid JSON: ${path}`);
		}
	}
	const owner = process.env.LIGHTHAL_OWNER || file.owner || "";
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner))
		throw new Fail(
			1,
			`set the GitHub owner: {"owner": "YOUR-GITHUB-ORG"} in ${path}, or LIGHTHAL_OWNER`,
		);
	return {
		owner,
		defaultRepo: process.env.LIGHTHAL_DEFAULT_REPO || file.defaultRepo,
		author: process.env.LIGHTHAL_AUTHOR || file.author,
		appRepos: process.env.LIGHTHAL_APP_REPOS
			? process.env.LIGHTHAL_APP_REPOS.split(",").map((r) => r.trim())
			: file.appRepos,
	};
}

/** <owner>/<name> or <name> → <name>, refusing other owners and unsafe names. */
function repoName(repo: string, owner: string) {
	const parts = repo.split("/");
	if (parts.length > 2)
		throw new Fail(1, `repo must be ${owner}/<name>: ${repo}`);
	if (parts.length === 2 && parts[0] !== owner)
		throw new Fail(1, `only ${owner} repos are allowed: ${repo}`);
	const name = parts.at(-1) ?? "";
	if (
		!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) ||
		name.includes("..") ||
		name.endsWith(".git")
	)
		throw new Fail(1, `unsafe repo name: ${repo}`);
	return name;
}

/** A path under $LIGHTHAL_HOME/<sub>, refused if it resolves anywhere else. */
function under(sub: string, name: string) {
	const root = resolve(HOME, sub);
	const p = resolve(root, name);
	if (!p.startsWith(root + sep))
		throw new Fail(1, `path escapes ${root}: ${name}`);
	return p;
}

function remoteHeads(url: string) {
	const heads: Record<string, string> = {};
	for (const line of git(undefined, "ls-remote", "--heads", url).split("\n")) {
		const [sha, ref] = line.split("\t");
		if (sha && ref) heads[ref] = sha;
	}
	return heads;
}

function pidAlive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** One lock for the whole start: every start uses the same pad. */
function lock() {
	const dir = join(HOME, "locks");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "pad.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, String(process.pid), { flag: "wx" });
			return () => rmSync(path, { force: true });
		} catch {
			const holder = Number(readFileSync(path, "utf8"));
			if (holder && pidAlive(holder))
				throw new Fail(
					1,
					`the pad is busy (start pid ${holder}); try again in a few seconds`,
				);
			rmSync(path, { force: true }); // stale lock from a dead run
		}
	}
	throw new Fail(1, "could not take the pad lock");
}

/** Empty the pad and fresh-clone the target repo's base branch into it. */
function preparePad(url: string, base: string) {
	const pad = resolve(HOME, "pad");
	if (existsSync(pad)) {
		if (lstatSync(pad).isSymbolicLink())
			throw new Fail(1, `pad must not be a symlink: ${pad}`);
		for (const entry of readdirSync(pad))
			rmSync(join(pad, entry), { recursive: true, force: true });
	} else mkdirSync(pad, { recursive: true });
	git(undefined, "clone", "-q", "--no-tags", "--branch", base, url, pad);
	if (git(pad, "remote").split("\n").filter(Boolean).join() !== "origin")
		throw new Fail(1, `pad ${pad} must have origin as its only remote`);
	if (git(pad, "status", "--porcelain") !== "")
		throw new Fail(1, `pad ${pad} is not clean`);
	return { pad, baseCommit: git(pad, "rev-parse", "HEAD") };
}

/** Per-repo bare cache for wait(), seeded with the base commit from the pad. */
function prepareCache(name: string, url: string, pad: string, ticket: string) {
	const cache = under("cache", `${name}.git`);
	if (!existsSync(cache)) {
		mkdirSync(cache, { recursive: true });
		git(cache, "init", "-q", "--bare");
		git(cache, "remote", "add", "origin", url);
	}
	git(
		cache,
		"fetch",
		"-q",
		"--no-tags",
		pad,
		`+HEAD:refs/lighthal-base/${ticket}`,
	);
	return cache;
}

function newTicket() {
	const iso = new Date().toISOString(); // 2026-10-13T14:05:09.123Z
	const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
	const bytes = crypto.getRandomValues(new Uint8Array(6));
	const suffix = Array.from(
		bytes,
		(b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36],
	).join("");
	return `lh-${stamp}-${suffix}`;
}

function footer(ticket: string, author?: string) {
	const authorLine = author
		? `3. Use the author ${author} for every commit.\n`
		: "";
	return `

---
lightHAL ticket: ${ticket}
When the task is finished, or if you cannot finish it:
1. Commit your work in normal commits whose subjects start with "lightHAL ${ticket}: ".
2. Then make one final EMPTY commit (git commit --allow-empty) whose subject is exactly
   "lightHAL ${ticket} done" and whose body is a short summary: what you did, the test or check
   output, anything left open. If you could not do the task, still make this commit and say why.
${authorLine}${author ? 4 : 3}. Push to your own claude/* branch only. Do not push any other branch, do not open a pull
   request, and do not change settings or permissions.
`;
}

/** Fail closed: a prompt that may hold a secret is never sent. */
function scanForSecrets(dir: string) {
	const r = run([
		GITLEAKS_BIN,
		"detect",
		"--no-git",
		"--source",
		dir,
		"--redact",
		"--no-banner",
		"--exit-code",
		"42",
		"-l",
		"error",
	]);
	if (r.code === 42) {
		rmSync(dir, { recursive: true, force: true });
		throw new Fail(
			4,
			"gitleaks found a likely secret in the task; nothing was sent",
		);
	}
	if (r.code !== 0)
		throw new Fail(1, `gitleaks did not run cleanly: ${r.err || r.code}`);
}

const ANSI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape codes is the point
	/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

async function launch(clone: string, promptFile: string, logFile: string) {
	// Fixed command string: the task only ever reaches the shell as the contents of a file.
	const cmd =
		'exec "$LIGHTHAL_CLAUDE_BIN" --cloud "$(cat "$LIGHTHAL_PROMPT_FILE")"';
	// util-linux script (Linux) vs BSD script (macOS: log file first, then the command).
	const argv =
		process.platform === "darwin"
			? ["script", "-q", logFile, "/bin/sh", "-c", cmd]
			: ["script", "-qefc", cmd, logFile];
	const proc = Bun.spawn(argv, {
		cwd: clone,
		env: {
			...process.env,
			LIGHTHAL_CLAUDE_BIN: CLAUDE_BIN,
			LIGHTHAL_PROMPT_FILE: promptFile,
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
	}, LAUNCH_TIMEOUT_S * 1000);
	await proc.exited;
	clearTimeout(timer);

	const text = existsSync(logFile)
		? readFileSync(logFile, "utf8").replace(ANSI, "").replaceAll("\r", "")
		: "";
	const flat = text.replace(/\s+/g, "");
	const logTail = text
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("Script "))
		.slice(-15)
		.join("\n");
	const session = text.match(/session_[A-Za-z0-9]+/)?.[0];
	if (session && /Createdcloudsession/i.test(flat)) {
		return { session, sessionUrl: `https://claude.ai/code/${session}` };
	}
	if (/Itrustthisfolder/i.test(flat))
		throw new Fail(
			3,
			`pad not trusted yet: run \`cd ${clone} && claude\` once and pick "Yes, I trust this folder"`,
			{
				logTail,
			},
		);
	throw new Fail(
		3,
		timedOut
			? `no session after ${LAUNCH_TIMEOUT_S}s`
			: "no session id in the CLI output",
		{
			logTail,
		},
	);
}

async function start(flags: Record<string, string>): Promise<Out> {
	const cfg = loadConfig();
	const repo = flags.repo || cfg.defaultRepo;
	if (!repo)
		throw new Fail(1, "no repo: pass --repo or set defaultRepo in config");
	const name = repoName(repo, cfg.owner);
	if (cfg.appRepos && !cfg.appRepos.includes(name))
		throw new Fail(
			1,
			`${cfg.owner}/${name}: the Claude GitHub App is not installed on it (not in appRepos), so the cloud ` +
				"session would get an uploaded copy it cannot push back. Install the app on the repo " +
				`(github.com/apps/claude, Configure, Repository access), then add "${name}" to appRepos in ` +
				join(HOME, "config.json"),
		);
	const base = flags.base || "main";
	if (run(["git", "check-ref-format", "--branch", base]).code !== 0)
		throw new Fail(1, `bad base: ${base}`);
	let task = flags.task;
	if (flags["task-file"]) task = readFileSync(flags["task-file"], "utf8");
	if (!task?.trim()) throw new Fail(1, "no task: pass --task or --task-file");

	const url = `${REMOTE_BASE}/${cfg.owner}/${name}.git`;
	const heads = remoteHeads(url);
	if (!heads[`refs/heads/${base}`])
		throw new Fail(1, `base branch ${base} not found on ${url}`);

	const ticket = newTicket();
	const prompt = task.replace(/\s+$/, "") + footer(ticket, cfg.author);
	if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)
		throw new Fail(1, "task is over 100 KB");
	const promptDir = under("prompts", ticket);
	mkdirSync(promptDir, { recursive: true });
	const promptFile = join(promptDir, "prompt.txt");
	writeFileSync(promptFile, prompt);
	scanForSecrets(promptDir);

	const release = lock();
	try {
		const { pad, baseCommit } = preparePad(url, base);
		const cache = prepareCache(name, url, pad, ticket);
		const { session, sessionUrl } = await launch(
			pad,
			promptFile,
			join(promptDir, "launch.log"),
		);
		const state: State = {
			ticket,
			repo: `${cfg.owner}/${name}`,
			url,
			cache,
			base,
			baseCommit,
			session,
			sessionUrl,
			startedAt: new Date().toISOString(),
			baseline: heads,
			status: "started",
		};
		mkdirSync(join(HOME, "state"), { recursive: true });
		writeFileSync(
			under("state", `${ticket}.json`),
			`${JSON.stringify(state, null, 2)}\n`,
		);
		return {
			ticket,
			repo: state.repo,
			base,
			baseCommit,
			session,
			sessionUrl,
			wait: `bun ${import.meta.path} wait ${ticket}`,
		};
	} finally {
		release();
	}
}

function loadState(ticket: string): State {
	if (!/^lh-\d{8}-\d{6}-[a-z0-9]{6}$/.test(ticket))
		throw new Fail(1, `not a ticket: ${ticket}`);
	const path = under("state", `${ticket}.json`);
	if (!existsSync(path)) throw new Fail(1, `unknown ticket: ${ticket}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

interface Commit {
	sha: string;
	subject: string;
	body: string;
}

/** Where wait() fetches: the bare cache, or an older ticket's launch clone. */
const repoDir = (st: State) => st.cache ?? st.clone ?? "";

function newCommits(st: State, ref: string): Commit[] {
	const local = `refs/lighthal/${ref.slice("refs/heads/".length)}`;
	git(repoDir(st), "fetch", "-q", "--no-tags", "origin", `+${ref}:${local}`);
	const raw = git(
		repoDir(st),
		"log",
		"-n",
		"300",
		"--format=%H%x1f%s%x1f%b%x1e",
		local,
		"--not",
		st.baseCommit,
	);
	return raw
		.split("\x1e")
		.map((c) => c.trim())
		.filter(Boolean)
		.map((c) => {
			const [sha, subject, body] = c.split("\x1f");
			return { sha, subject, body: (body ?? "").trim() };
		});
}

/** Any branch other than claude/* that moved, appeared or vanished since start. */
function headWarnings(st: State, now: Record<string, string>) {
	const w: string[] = [];
	for (const [ref, sha] of Object.entries(st.baseline)) {
		if (ref.startsWith(CLAUDE_REF)) continue;
		if (!now[ref]) w.push(`deleted since start: ${ref}`);
		else if (now[ref] !== sha) w.push(`moved since start: ${ref}`);
	}
	for (const ref of Object.keys(now))
		if (!ref.startsWith(CLAUDE_REF) && !st.baseline[ref])
			w.push(`new branch since start: ${ref}`);
	return w;
}

async function wait(
	ticket: string,
	flags: Record<string, string>,
): Promise<Out> {
	const st = loadState(ticket);
	const timeoutMs = Number(flags["timeout-min"] || 60) * 60_000;
	const intervalMs = Number(flags["interval-s"] || 30) * 1000;
	const deadline = Date.now() + timeoutMs;
	const doneSubject = `lightHAL ${ticket} done`;
	let inProgress: string[] = [];
	let warnings: string[] = [];

	for (;;) {
		const now = remoteHeads(st.url);
		warnings = headWarnings(st, now);
		inProgress = [];
		for (const [ref, sha] of Object.entries(now)) {
			if (!ref.startsWith(CLAUDE_REF) || st.baseline[ref] === sha) continue;
			const commits = newCommits(st, ref);
			const branch = ref.slice("refs/heads/".length);
			const done = commits.find((c) => c.subject.trim() === doneSubject);
			if (done) {
				const files = git(
					repoDir(st),
					"diff",
					"--name-only",
					`${st.baseCommit}...${done.sha}`,
				)
					.split("\n")
					.filter(Boolean);
				const descendsFromBase =
					run(
						["git", "merge-base", "--is-ancestor", st.baseCommit, done.sha],
						repoDir(st),
					).code === 0;
				st.status = "done";
				st.result = { branch, commit: done.sha };
				writeFileSync(
					under("state", `${ticket}.json`),
					`${JSON.stringify(st, null, 2)}\n`,
				);
				return {
					ticket,
					status: "done",
					repo: st.repo,
					branch,
					commit: done.sha,
					summary: done.body,
					workCommits: commits
						.filter((c) => c !== done)
						.map((c) => ({ commit: c.sha.slice(0, 7), subject: c.subject })),
					files,
					descendsFromBase,
					warnings,
					sessionUrl: st.sessionUrl,
				};
			}
			if (
				branch.includes(ticket) ||
				commits.some((c) => c.subject.includes(ticket))
			)
				inProgress.push(branch);
		}
		if (Date.now() + intervalMs > deadline) break;
		await Bun.sleep(intervalMs);
	}
	throw new Fail(2, `no "${doneSubject}" commit yet`, {
		ticket,
		status: "timeout",
		inProgress,
		warnings,
		sessionUrl: st.sessionUrl,
		teleport: `claude --teleport ${st.session}`,
		resume: `bun ${import.meta.path} wait ${ticket}`,
	});
}

function status(ticket?: string): Out {
	if (ticket) return loadState(ticket) as unknown as Out;
	const dir = join(HOME, "state");
	const tickets = existsSync(dir)
		? readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort()
				.map((f) => {
					const s: State = JSON.parse(readFileSync(join(dir, f), "utf8"));
					return {
						ticket: s.ticket,
						repo: s.repo,
						status: s.status,
						startedAt: s.startedAt,
						sessionUrl: s.sessionUrl,
						result: s.result ?? null,
					};
				})
		: [];
	return { tickets };
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	try {
		const { flags, positional } = parseArgs(rest);
		let out: Out;
		if (cmd === "start") out = await start(flags);
		else if (cmd === "wait" && positional[0])
			out = await wait(positional[0], flags);
		else if (cmd === "status") out = status(positional[0]);
		else
			throw new Fail(
				1,
				"usage: lighthal.ts start|wait <ticket>|status [ticket] (see header)",
			);
		console.log(JSON.stringify(out, null, 2));
		process.exit(0);
	} catch (e) {
		const f = e instanceof Fail ? e : new Fail(1, String(e));
		console.log(JSON.stringify({ error: f.message, ...f.extra }, null, 2));
		process.exit(f.code);
	}
}

main();
