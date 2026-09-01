#!/usr/bin/env bun
// skynet: clone a repo, run its tests, let an LLM repair failures, remember what it learned.
//   bun skynet.ts <git-url|path> [--max-turns N]
//   bun skynet.ts evolve [--generations N] [--goal "text"] [--max-turns N] [--budget usd]
//   bun skynet.ts revert
//   bun skynet.ts --selftest
//   bun skynet.ts --version
import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages, ChatFunctionTool, ChatToolCall } from "@openrouter/sdk/models";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "fs";
import { basename, join, resolve } from "path";
import { tmpdir } from "os";

const HOME = process.env.SKYNET_HOME ?? join(process.env.HOME!, ".skynet");
const MEMORY = join(HOME, "memory.md");
const WORK = join(HOME, "work");
const MODEL = process.env.SKYNET_MODEL ?? "z-ai/glm-5.3-flash";
export const VERSION = "0.1.0";

// ---------- shell ----------
// cancellable delay: a bare Bun.sleep can't be cancelled, and a still-pending one keeps bun's event
// loop alive after sh() resolves (measured: a 60s sleep pinned process exit for the full 60s)
function delay(ms: number) {
  let fire!: () => void;
  const done = new Promise<void>((res) => (fire = res));
  const t = setTimeout(fire, ms);
  return { done, cancel: () => { clearTimeout(t); fire(); } };
}

const KILL_GRACE_MS = 2_000;

export async function sh(cmd: string, cwd: string, timeoutMs = 120_000, env?: Record<string, string>) {
  const p = Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  p.unref(); // don't let a timed-out command's orphans pin bun's event loop open after sh() resolves
  const parts = { out: "", err: "" };
  const pump = async (stream: ReadableStream<Uint8Array>, key: "out" | "err") => {
    const dec = new TextDecoder();
    for await (const chunk of stream) parts[key] += dec.decode(chunk, { stream: true });
    parts[key] += dec.decode();
  };
  // race streams + exit against the timeout: a killed bash's grandchildren inherit the pipes and
  // would otherwise pin EOF forever, so Promise.all alone bounds nothing
  const collect = (async () => {
    await Promise.all([pump(p.stdout, "out"), pump(p.stderr, "err")]);
    return p.exited;
  })();
  const timer = delay(timeoutMs);
  const code = await Promise.race([collect, timer.done.then(() => null)]);
  timer.cancel();
  if (code === null) {
    p.kill(9); // SIGKILL: SIGTERM is trappable (`trap '' TERM`) and grandchildren can outlive it anyway
    const grace = delay(KILL_GRACE_MS);
    await Promise.race([collect, grace.done]); // let buffered output drain; give up if pipes stay wedged
    grace.cancel();
    return { code: 124, text: (parts.out + parts.err + `\n[skynet: timed out after ${timeoutMs}ms]`).slice(-20_000) };
  }
  return { code, text: (parts.out + parts.err).slice(-20_000) }; // ponytail: tail-cap output, add smarter trimming if repos exceed it
}

// ---------- clone ----------
export async function clone(target: string) {
  mkdirSync(WORK, { recursive: true });
  if (existsSync(target)) return resolve(target);
  const dir = join(WORK, basename(target).replace(/\.git$/, ""));
  const r = existsSync(dir)
    ? await sh("git pull --ff-only", dir)
    : await sh(`git clone --depth 50 ${JSON.stringify(target)} ${JSON.stringify(dir)}`, WORK);
  if (r.code !== 0) throw new Error(`clone failed: ${r.text}`);
  return dir;
}

// ---------- detect ----------
export function detectTestCmd(dir: string): string | null {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("package.json")) {
    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      pkg = null; // malformed/unparseable package.json: fall through to the other detectors
    }
    if (pkg?.scripts?.test) return has("bun.lock") || has("bun.lockb") ? "bun install && bun run test" : "npm install --silent && npm test";
    if (pkg) return "bun test";
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "python -m pytest -q";
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("Makefile") && /^test:/m.test(readFileSync(join(dir, "Makefile"), "utf8"))) return "make test";
  const glob = new Bun.Glob("**/*{.test.ts,.test.js,_test.ts,_test.js}");
  for (const _ of glob.scanSync({ cwd: dir })) return "bun test";
  return null;
}

// ---------- learn ----------
export function recall() {
  return existsSync(MEMORY) ? readFileSync(MEMORY, "utf8") : "";
}
export function learn(repo: string, lesson: string) {
  mkdirSync(HOME, { recursive: true });
  appendFileSync(MEMORY, `- [${new Date().toISOString().slice(0, 10)}] ${repo}: ${lesson.trim()}\n`);
}

// ---------- repair ----------
const bashTool: ChatFunctionTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a bash command in the repo root. Use it to read, edit (sed/heredoc) and run code.",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
    strict: true,
  },
};

// ---------- tool-call boundary ----------
// guard the tool-call boundary: model-provided tool arguments are untrusted, so parse
// defensively and return { error } instead of letting one malformed call crash the whole
// repair/evolve run.
export function parseToolCmd(raw: string): { cmd: string } | { error: string } {
  try {
    const parsed = JSON.parse(raw) as { cmd?: unknown };
    if (typeof parsed?.cmd !== "string") return { error: "missing or non-string cmd" };
    return { cmd: parsed.cmd };
  } catch {
    return { error: "invalid JSON" };
  }
}

// ponytail: heuristic denylist (dir escape, .env, sudo, recursive evolve), not a sandbox.
// Real containment needs bwrap/firejail/chroot if this matters more. The recursive-evolve
// clause is belt-and-braces on top of the SKYNET_CHILD guard in evolve()/run() below.
export function isBlockedCmd(cmd: string): boolean {
  return /(^|[\s;&|])cd\s+(\.\.|~|\/)|\.env\b|\bsudo\b|skynet\.ts\s+evolve\b/.test(cmd);
}

// generic tool-loop: give the model a bash tool in `dir` until it replies with no tool calls.
// returns the text after "LESSON:" on its final line, or null if maxTurns ran out / no lesson.
// usage accounting: the SDK always returns full usage per response (no request flag needed).
// caching: mark the system prompt (the stable prefix) with an Anthropic-style cache_control
// breakpoint; OpenRouter converts it to whatever the serving provider needs (OpenAI-style
// prompt_cache_breakpoint, native Anthropic cache_control, or ignores it if unsupported).
// maxCost: stop the loop (without running the turn's tool calls) once accumulated spend passes
// it; childEnv: extra env vars for every bash tool call (evolve() uses this to set SKYNET_CHILD).
export async function agentLoop(
  dir: string,
  system: string,
  user: string,
  maxTurns: number,
  maxCost = Infinity,
  childEnv?: Record<string, string>,
) {
  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY });
  const messages: ChatMessages[] = [
    { role: "system", content: [{ type: "text", text: system, cacheControl: { type: "ephemeral" } }] },
    { role: "user", content: user },
  ];
  let totalCost = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.chat.send({ chatRequest: { model: MODEL, messages, tools: [bashTool] } });
    if (!("choices" in res)) throw new Error("unexpected streaming response");
    const u = res.usage;
    totalCost += u?.cost ?? 0;
    console.log(
      `turn ${turn + 1}: prompt=${u?.promptTokens ?? "?"} cached=${u?.promptTokensDetails?.cachedTokens ?? 0} completion=${u?.completionTokens ?? "?"} cost=$${(u?.cost ?? 0).toFixed(6)}`,
    );
    if (totalCost > maxCost) {
      console.log(`budget exceeded: $${totalCost.toFixed(6)} > $${maxCost.toFixed(6)}, stopping`);
      return { lesson: null, totalCost, budgetExceeded: true };
    }
    const msg = res.choices[0]!.message;
    messages.push({ role: "assistant", content: msg.content ?? null, toolCalls: msg.toolCalls } as ChatMessages);
    if (typeof msg.content === "string" && msg.content) console.log(msg.content);
    const calls: ChatToolCall[] = msg.toolCalls ?? [];
    if (!calls.length) {
      const text = typeof msg.content === "string" ? msg.content : "";
      return { lesson: text.match(/^LESSON:(.*)$/m)?.[1] ?? null, totalCost, budgetExceeded: false };
    }
    for (const c of calls) {
      const parsed = parseToolCmd(c.function.arguments);
      if ("error" in parsed) {
        // bounce malformed arguments back to the model as a tool message so it can retry
        messages.push({ role: "tool", toolCallId: c.id, content: `exit 1\nblocked: malformed tool arguments, expected {"cmd": string}` });
        continue;
      }
      const cmd = parsed.cmd;
      console.log(`$ ${cmd}`);
      const blocked = isBlockedCmd(cmd);
      const r = blocked
        ? { code: 1, text: "blocked: command attempts to leave the working directory, touch .env/sudo, or run a recursive evolve" }
        : await sh(cmd, dir, undefined, childEnv);
      messages.push({ role: "tool", toolCallId: c.id, content: `exit ${r.code}\n${r.text}` });
    }
  }
  return { lesson: null, totalCost, budgetExceeded: totalCost > maxCost };
}

export async function repair(dir: string, testCmd: string, failure: string, maxTurns: number) {
  const system = `You repair failing test suites. Repo root: ${dir}. Test command: ${testCmd}.
Fix the root cause with minimal diffs. Never disable, skip or delete tests. Do not commit.
When tests pass, reply with exactly one line starting with "LESSON:" describing what was reusable about this fix.
${recall() ? "Lessons from previous repos:\n" + recall() : ""}`;
  return agentLoop(dir, system, `Tests fail:\n\n${failure}`, maxTurns);
}

// ---------- main ----------
export async function run(target: string, maxTurns: number) {
  if (process.env.SKYNET_CHILD) throw new Error("run: refusing to run recursively inside a child (SKYNET_CHILD is set)");
  const dir = await clone(target);
  const testCmd = detectTestCmd(dir);
  if (!testCmd) throw new Error(`no test command detected in ${dir}`);
  console.log(`repo: ${dir}\ntest: ${testCmd}`);

  const first = await sh(testCmd, dir, 600_000);
  if (first.code === 0) return console.log("tests already pass");

  const { lesson, totalCost } = await repair(dir, testCmd, first.text, maxTurns);
  const after = await sh(testCmd, dir, 600_000);
  if (after.code !== 0) throw new Error(`still failing after ${maxTurns} turns:\n${after.text}`);

  await sh(`git add -A && git commit -qm "fix: skynet auto-repair" || true`, dir);
  learn(basename(dir), lesson ?? "fixed failing tests (no lesson reported)");
  console.log(`repaired + committed. memory: ${MEMORY}`);
  console.log(`total cost: $${totalCost.toFixed(6)}`);
}

// ---------- evolve ----------
export function nextGenDir(genRoot: string): number {
  if (!existsSync(genRoot)) return 1;
  const nums = readdirSync(genRoot).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

export function parsePositiveIntegerFlag(flag: string, raw: string | undefined): number {
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer (got ${raw ?? "missing value"})`);
  }
  return value;
}

export function parseEvolveFlags(argv: string[]) {
  const flags = [...argv];
  const gi = flags.indexOf("--generations");
  const generations = gi >= 0 ? parsePositiveIntegerFlag("--generations", flags.splice(gi, 2)[1]) : 3;
  const goi = flags.indexOf("--goal");
  const goal = goi >= 0 ? flags.splice(goi, 2)[1] : undefined;
  const mti = flags.indexOf("--max-turns");
  const maxTurns = mti >= 0 ? parsePositiveIntegerFlag("--max-turns", flags.splice(mti, 2)[1]) : 15;
  const bi = flags.indexOf("--budget");
  const budget = bi >= 0 ? Number(flags.splice(bi, 2)[1]) : 0.05;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget must be a positive number (got ${flags[bi]})`);
  return { generations, goal, maxTurns, budget };
}

// ---------- gate: the parent judges the child, the child must not be able to weaken the judgment ----------
// files the child must never touch at all (any diff touching these is an automatic reject)
export const ALWAYS_PROTECTED_FILES = ["smoke.test.ts", ".env", ".gitignore", "CLAUDE.md"];

export function touchedFiles(gitDiffNameOnlyOutput: string): string[] {
  return gitDiffNameOnlyOutput.split("\n").map((s) => s.trim()).filter(Boolean);
}

// allowlist for what the child's diff may touch: skynet.ts always, package.json/bun.lock only
// when the goal itself calls for a dependency change (no new deps by default). Anything in
// ALWAYS_PROTECTED_FILES, or any other file (new or existing) outside that set, is rejected.
export function disallowedDiffFiles(files: string[], goal: string): string[] {
  const goalMentionsDeps = /package\.json|bun\.lock|\bdepend/i.test(goal);
  const allowed = new Set(["skynet.ts", ...(goalMentionsDeps ? ["package.json", "bun.lock"] : [])]);
  return files.filter((f) => ALWAYS_PROTECTED_FILES.includes(f) || !allowed.has(f));
}

// subject <=72 chars (git convention), full goal always in the body; written to a file and
// committed with `git commit -F` so backticks/quotes in the goal never round-trip through bash -lc.
export function evolveCommitMessage(n: number, goal: string): string {
  const full = `evolve gen ${n}: ${goal}`;
  const subject = full.length <= 72 ? full : full.slice(0, 69) + "...";
  return `${subject}\n\n${goal}`;
}

async function diffReview(child: string, goal: string): Promise<{ pass: boolean; reason: string }> {
  const reviewModel = process.env.SKYNET_REVIEW_MODEL;
  if (!reviewModel) return { pass: true, reason: "skipped (SKYNET_REVIEW_MODEL not set)" };
  const diff = (await sh("git diff", child)).text.slice(-20_000);
  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY });
  const res = await client.chat.send({
    chatRequest: {
      model: reviewModel,
      messages: [
        {
          role: "system",
          content:
            "You are a strict code reviewer for an autonomous agent's self-modification. Check: the diff matches the stated goal, no test was weakened or removed, no gate/selftest logic was removed, and there are no unrelated changes. Reply with exactly two lines: the first line exactly PASS or FAIL, the second line a one-line reason.",
        },
        { role: "user", content: `Goal: ${goal}\n\nDiff:\n${diff}` },
      ],
    },
  });
  if (!("choices" in res)) throw new Error("unexpected streaming response");
  const cost = res.usage?.cost ?? 0;
  console.log(`diff review (${reviewModel}) cost=$${cost.toFixed(6)}`);
  const text = (res.choices[0]!.message.content as string) ?? "";
  const [verdict, ...rest] = text.trim().split("\n");
  return { pass: verdict?.trim() === "PASS", reason: rest.join(" ").trim() || "(no reason given)" };
}

// order: no-diff -> protected/allowlist -> install -> tsc -> selftest -> smoke (parent's copy) -> diff review
export async function gate(child: string, n: number, goal: string): Promise<{ ok: boolean; reason: string }> {
  const diffStat = await sh("git diff --stat", child);
  if (!diffStat.text.trim()) return { ok: false, reason: "no diff produced" };

  const nameOnly = await sh("git diff --name-only", child);
  const disallowed = disallowedDiffFiles(touchedFiles(nameOnly.text), goal);
  if (disallowed.length) return { ok: false, reason: `touched disallowed files: ${disallowed.join(", ")}` };

  const inst = await sh("bun install", child, 300_000);
  if (inst.code !== 0) return { ok: false, reason: `bun install failed: ${inst.text.slice(-500)}` };

  const tsc = await sh("bunx tsc --noEmit", child, 120_000);
  if (tsc.code !== 0) return { ok: false, reason: `tsc failed: ${tsc.text.slice(-500)}` };

  const st = await sh(`SKYNET_HOME=${JSON.stringify(join(tmpdir(), `skynet-gate-selftest-${n}-${Date.now()}`))} bun skynet.ts --selftest`, child, 60_000);
  if (st.code !== 0) return { ok: false, reason: `selftest failed: ${st.text.slice(-500)}` };

  // parent copies its own smoke test over whatever the child left, so the child can't weaken it
  await Bun.write(join(child, "smoke.test.ts"), readFileSync(join(import.meta.dir, "smoke.test.ts")));
  const smoke = await sh(`SKYNET_HOME=${JSON.stringify(join(tmpdir(), `skynet-gate-smoke-${n}-${Date.now()}`))} bun test smoke.test.ts`, child, 120_000);
  if (smoke.code !== 0) return { ok: false, reason: `smoke test failed: ${smoke.text.slice(-500)}` };

  const review = await diffReview(child, goal);
  if (!review.pass) return { ok: false, reason: `diff review: ${review.reason}` };

  return { ok: true, reason: "gate passed" };
}

export async function revert(ROOT: string = import.meta.dir) {
  const subj = (await sh("git log -1 --pretty=%s", ROOT)).text.trim();
  if (!subj.startsWith("evolve gen")) {
    console.error("HEAD is not an evolve commit");
    process.exit(1);
  }
  const r = await sh("git revert --no-edit HEAD", ROOT, 60_000);
  if (r.code !== 0) throw new Error(`git revert failed: ${r.text}`);
  learn("self", `reverted gen: ${subj}`);
  console.log(`reverted: ${subj}`);
}

async function ensureRepo(dir: string) {
  if (existsSync(join(dir, ".git"))) return;
  await sh("git init -q", dir);
  await sh(`git add -A && git commit -qm "chore: initial commit"`, dir);
}

async function pickGoal(childDir: string) {
  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY });
  const src = readFileSync(join(childDir, "skynet.ts"), "utf8");
  const res = await client.chat.send({
    chatRequest: {
      model: MODEL,
      messages: [
        {
          role: "user",
          content: `You are skynet, choosing your own next self-improvement.\nLessons so far:\n${recall() || "(none)"}\n\nCurrent source (skynet.ts):\n${src}\n\nReply with exactly one line: one small, concrete improvement to make to skynet.ts.`,
        },
      ],
    },
  });
  if (!("choices" in res)) throw new Error("unexpected streaming response");
  const text = (res.choices[0]!.message.content as string) ?? "";
  return text.trim().split("\n")[0]!;
}

export async function evolve(generations: number, goalArg: string | undefined, maxTurns: number, budget: number) {
  if (process.env.SKYNET_CHILD) throw new Error("evolve: refusing to run recursively inside a child (SKYNET_CHILD is set)");
  const ROOT = import.meta.dir;
  await ensureRepo(ROOT);
  // commit any pre-existing dirty state in ROOT *before* cloning, so the child (and its later
  // gen commit) descends from it — otherwise the child's commit and a post-clone pre-evolve
  // commit are siblings and the ff-only pull below can never fast-forward.
  const dirty0 = await sh("git status --porcelain", ROOT);
  if (dirty0.text.trim()) await sh(`git add -A && git commit -qm "chore: pre-evolve"`, ROOT);

  const genRoot = join(HOME, "gen");
  mkdirSync(genRoot, { recursive: true });
  const n = nextGenDir(genRoot);
  const child = join(genRoot, String(n));

  const cl = await sh(`git clone ${JSON.stringify(ROOT)} ${JSON.stringify(child)}`, genRoot, 300_000);
  if (cl.code !== 0) throw new Error(`self-clone failed: ${cl.text}`);
  if (existsSync(join(ROOT, ".env"))) await Bun.write(join(child, ".env"), readFileSync(join(ROOT, ".env")));
  const inst = await sh("bun install", child, 300_000);
  if (inst.code !== 0) throw new Error(`bun install failed in ${child}: ${inst.text}`);

  const goal = goalArg ?? (await pickGoal(child));
  console.log(`gen ${n} goal: ${goal}`);

  const system = `You are skynet, improving your own source at ${child}. Goal: ${goal}.
Constraints: only edit files inside this directory, never touch .env, keep "bun skynet.ts --selftest" and "bunx tsc --noEmit" passing, add one selftest assertion covering your change, do not commit.
Never touch these files: ${ALWAYS_PROTECTED_FILES.join(", ")} — any change to them causes automatic rejection. package.json and bun.lock are also rejected unless this goal explicitly asks for a dependency change.
Never run "bun skynet.ts evolve" or "bun skynet.ts <target>" — this is a self-modification task, not an evolve/repair run; that is blocked and will fail.
When done, reply with exactly one line starting with "LESSON:".`;
  const { lesson, totalCost, budgetExceeded } = await agentLoop(child, system, "Make the change now.", maxTurns, budget, { SKYNET_CHILD: "1" });
  console.log(`gen ${n} total cost: $${totalCost.toFixed(6)}`);

  const gateResult = budgetExceeded
    ? { ok: false, reason: `budget exceeded ($${totalCost.toFixed(6)} > $${budget.toFixed(6)})` }
    : await gate(child, n, goal);

  if (gateResult.ok) {
    const msgPath = join(tmpdir(), `skynet-commit-msg-${n}-${Date.now()}.txt`);
    await Bun.write(msgPath, evolveCommitMessage(n, goal));
    await sh(`git add -A && git commit -qF ${JSON.stringify(msgPath)}`, child);
    const pull = await sh(`git pull --ff-only ${JSON.stringify(child)} HEAD`, ROOT, 60_000);
    if (pull.code !== 0) throw new Error(`ff-only pull failed: ${pull.text}`);
    learn("self", `gen ${n} promoted: ${goal}: ${lesson ?? "(no lesson)"}`);
    console.log(`gen ${n} promoted.`);
  } else {
    learn("self", `gen ${n} rejected: ${goal}: ${gateResult.reason}`);
    console.log(`gen ${n} rejected (${gateResult.reason}), left at ${child} for inspection.`);
  }

  const remaining = generations - 1;
  if (remaining > 0) {
    const argv = ["evolve", "--generations", String(remaining), "--max-turns", String(maxTurns), "--budget", String(budget)];
    if (goalArg) argv.push("--goal", goalArg);
    const p = Bun.spawn(["bun", join(ROOT, "skynet.ts"), ...argv], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await p.exited);
  }
}

// ---------- selftest (offline) ----------
async function selftest() {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error("selftest: " + m); };
  // scratch dirs live under the OS tmpdir, never under HOME/cwd — HOME may be a caller-chosen
  // relative path (e.g. gate() setting SKYNET_HOME for an isolated run) and these fixtures must
  // never land inside a git working tree and get swept up by a later `git add -A`.
  const scratch = join(tmpdir(), `skynet-selftest-${process.pid}-${Date.now()}`);
  const tmp = join(scratch, "pkg"); mkdirSync(tmp, { recursive: true });
  await Bun.write(join(tmp, "package.json"), '{"scripts":{"test":"bun test"}}');
  await Bun.write(join(tmp, "bun.lock"), "");
  assert(detectTestCmd(tmp) === "bun install && bun run test", "detect bun");
  await Bun.write(join(tmp, "package.json"), "{}");
  assert(detectTestCmd(tmp) === "bun test", "detect bare bun");
  const globDir = join(scratch, "glob"); mkdirSync(globDir, { recursive: true });
  await Bun.write(join(globDir, "add.test.ts"), "");
  assert(detectTestCmd(globDir) === "bun test", "detect glob test file, no package.json");
  const badPkgDir = join(scratch, "badpkg"); mkdirSync(badPkgDir, { recursive: true });
  await Bun.write(join(badPkgDir, "package.json"), "{not json!!");
  await Bun.write(join(badPkgDir, "add.test.ts"), "");
  assert(detectTestCmd(badPkgDir) === "bun test", "detect bun test with malformed package.json");
  assert((await sh("exit 3", tmp)).code === 3, "sh exit code");
  assert((await sh("echo hi", tmp)).text.trim() === "hi", "sh output");
  {
    // timeout must actually bound the call: the sleeping grandchild inherits the pipes, so a
    // SIGTERM-only kill of bash used to leave the stream collect wedged until sleep 30 finished
    const t0 = Date.now();
    const r = await sh("sleep 30", tmp, 300);
    const ms = Date.now() - t0;
    assert(r.code !== 0 && ms < 10_000, `sh timeout enforced (got code ${r.code} after ${ms}ms)`);
    assert(r.text.includes("[skynet: timed out after 300ms]"), "sh timeout reports itself to the model");
  }
  const local = await clone(tmp); assert(local === resolve(tmp), "clone local path passthrough");
  learn("selftest", "memory works"); assert(recall().includes("selftest: memory works"), "learn/recall");

  assert(nextGenDir(join(scratch, "gen-missing")) === 1, "nextGenDir empty");
  const genDir = join(scratch, "gen");
  mkdirSync(join(genDir, "1"), { recursive: true });
  mkdirSync(join(genDir, "3"), { recursive: true });
  assert(nextGenDir(genDir) === 4, "nextGenDir counter");

  const f1 = parseEvolveFlags([]);
  assert(f1.generations === 3 && f1.goal === undefined && f1.maxTurns === 15 && f1.budget === 0.05, "parseEvolveFlags defaults");
  const f2 = parseEvolveFlags(["--generations", "5", "--goal", "x y", "--max-turns", "7", "--budget", "0.2"]);
  assert(f2.generations === 5 && f2.goal === "x y" && f2.maxTurns === 7 && f2.budget === 0.2, "parseEvolveFlags overrides");
  assert(["0", "-1", "nope", "Infinity"].every((n) => { try { parsePositiveIntegerFlag("--max-turns", n); return false; } catch { return true; } }), "numeric flags reject invalid values");
  assert(["0", "-1", "nope"].every((n) => { try { parseEvolveFlags(["--budget", n]); return false; } catch { return true; } }), "--budget rejects invalid values");

  const pc = parseToolCmd('{"cmd":"ls"}');
  assert("cmd" in pc && pc.cmd === "ls", "parseToolCmd accepts valid cmd");
  assert("error" in parseToolCmd('"{nope"'), "parseToolCmd rejects unparseable args");
  assert("error" in parseToolCmd('{"x":1}'), "parseToolCmd rejects missing/non-string cmd");

  assert(isBlockedCmd("cd .. && ls"), "denylist blocks cd ..");
  assert(isBlockedCmd("cat .env"), "denylist blocks .env");
  assert(isBlockedCmd("bun skynet.ts evolve --goal x"), "denylist blocks recursive evolve");
  assert(!isBlockedCmd("echo hi"), "denylist allows plain commands");

  assert(disallowedDiffFiles(["smoke.test.ts"], "fix bug").length === 1, "smoke.test.ts always disallowed");
  assert(disallowedDiffFiles(["skynet.ts"], "fix bug").length === 0, "skynet.ts allowed");
  assert(disallowedDiffFiles(["package.json"], "fix bug").length === 1, "package.json disallowed without a deps goal");
  assert(disallowedDiffFiles(["package.json"], "add a new dependency").length === 0, "package.json allowed when goal mentions deps");
  assert(disallowedDiffFiles(["random-new-file.ts"], "fix bug").length === 1, "unrelated new file disallowed");

  const cmsg = evolveCommitMessage(1, "a".repeat(100));
  assert(cmsg.split("\n")[0]!.length <= 72, "commit subject capped at 72 chars");
  assert(cmsg.includes("a".repeat(100)), "commit body carries the full goal");

  {
    // SKYNET_CHILD guard: evolve()/run() must refuse to run recursively inside a child, so a
    // self-modifying agent can't spend budget on (or promote via) a nested evolve/repair run.
    const guardEvolve = await sh("SKYNET_CHILD=1 bun skynet.ts evolve --generations 1 --max-turns 1", import.meta.dir, 20_000);
    assert(guardEvolve.code !== 0 && guardEvolve.text.includes("SKYNET_CHILD"), "evolve refuses to run when SKYNET_CHILD is set");
    const guardRun = await sh("SKYNET_CHILD=1 bun skynet.ts /nonexistent-target-xyz", import.meta.dir, 20_000);
    assert(guardRun.code !== 0 && guardRun.text.includes("SKYNET_CHILD"), "run refuses to run when SKYNET_CHILD is set");
  }

  assert(VERSION === "0.1.0", "--version reports 0.1.0");

  console.log("selftest ok");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--version") console.log(VERSION);
  else if (args[0] === "--selftest") await selftest();
  else if (args[0] === "evolve") {
    try {
      const { generations, goal, maxTurns, budget } = parseEvolveFlags(args.slice(1));
      await evolve(generations, goal, maxTurns, budget);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  } else if (args[0] === "revert") {
    try {
      await revert();
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  } else if (!args[0]) {
    console.error("usage: bun skynet.ts <git-url|path> [--max-turns N] | evolve [--generations N] [--goal text] [--max-turns N] [--budget usd] | revert | --selftest | --version");
    process.exit(1);
  } else {
    try {
      const mt = args.indexOf("--max-turns");
      const maxTurns = mt >= 0 ? parsePositiveIntegerFlag("--max-turns", args.splice(mt, 2)[1]) : 25;
      await run(args[0], maxTurns);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }
}
