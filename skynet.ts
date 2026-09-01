#!/usr/bin/env bun
// skynet: clone a repo, run its tests, let an LLM repair failures, remember what it learned.
//   bun skynet.ts <git-url|path> [--max-turns N]
//   bun skynet.ts evolve [--generations N] [--goal "text"] [--max-turns N]
//   bun skynet.ts --selftest
//   bun skynet.ts --version
import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages, ChatFunctionTool, ChatToolCall } from "@openrouter/sdk/models";
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "fs";
import { basename, join, resolve } from "path";

const HOME = process.env.SKYNET_HOME ?? join(process.env.HOME!, ".skynet");
const MEMORY = join(HOME, "memory.md");
const WORK = join(HOME, "work");
const MODEL = process.env.SKYNET_MODEL ?? "z-ai/glm-5.3-flash";
export const VERSION = "0.1.0";

// ---------- shell ----------
export async function sh(cmd: string, cwd: string, timeoutMs = 120_000) {
  const p = Bun.spawn(["bash", "-lc", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(t);
  return { code, text: (out + err).slice(-20_000) }; // ponytail: tail-cap output, add smarter trimming if repos exceed it
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
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg.scripts?.test) return has("bun.lock") || has("bun.lockb") ? "bun install && bun run test" : "npm install --silent && npm test";
    return "bun test";
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

// generic tool-loop: give the model a bash tool in `dir` until it replies with no tool calls.
// returns the text after "LESSON:" on its final line, or null if maxTurns ran out / no lesson.
export async function agentLoop(dir: string, system: string, user: string, maxTurns: number) {
  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_KEY });
  const messages: ChatMessages[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const res = await client.chat.send({ chatRequest: { model: MODEL, messages, tools: [bashTool] } });
    if (!("choices" in res)) throw new Error("unexpected streaming response");
    const msg = res.choices[0]!.message;
    messages.push({ role: "assistant", content: msg.content ?? null, toolCalls: msg.toolCalls } as ChatMessages);
    if (typeof msg.content === "string" && msg.content) console.log(msg.content);
    const calls: ChatToolCall[] = msg.toolCalls ?? [];
    if (!calls.length) {
      const text = typeof msg.content === "string" ? msg.content : "";
      return text.match(/^LESSON:(.*)$/m)?.[1] ?? null;
    }
    for (const c of calls) {
      const { cmd } = JSON.parse(c.function.arguments) as { cmd: string };
      console.log(`$ ${cmd}`);
      // ponytail: heuristic denylist (dir escape, .env, sudo), not a sandbox. Real containment needs bwrap/firejail/chroot if this matters more.
      const blocked = /(^|[\s;&|])cd\s+(\.\.|~|\/)|\.env\b|\bsudo\b/.test(cmd);
      const r = blocked
        ? { code: 1, text: "blocked: command attempts to leave the working directory or touch .env/sudo" }
        : await sh(cmd, dir);
      messages.push({ role: "tool", toolCallId: c.id, content: `exit ${r.code}\n${r.text}` });
    }
  }
  return null;
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
  const dir = await clone(target);
  const testCmd = detectTestCmd(dir);
  if (!testCmd) throw new Error(`no test command detected in ${dir}`);
  console.log(`repo: ${dir}\ntest: ${testCmd}`);

  const first = await sh(testCmd, dir, 600_000);
  if (first.code === 0) return console.log("tests already pass");

  const lesson = await repair(dir, testCmd, first.text, maxTurns);
  const after = await sh(testCmd, dir, 600_000);
  if (after.code !== 0) throw new Error(`still failing after ${maxTurns} turns:\n${after.text}`);

  await sh(`git add -A && git commit -qm "fix: skynet auto-repair" || true`, dir);
  learn(basename(dir), lesson ?? "fixed failing tests (no lesson reported)");
  console.log(`repaired + committed. memory: ${MEMORY}`);
}

// ---------- evolve ----------
export function nextGenDir(genRoot: string): number {
  if (!existsSync(genRoot)) return 1;
  const nums = readdirSync(genRoot).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

export function parseEvolveFlags(argv: string[]) {
  const flags = [...argv];
  const gi = flags.indexOf("--generations");
  const generations = gi >= 0 ? Number(flags.splice(gi, 2)[1]) : 3;
  const goi = flags.indexOf("--goal");
  const goal = goi >= 0 ? flags.splice(goi, 2)[1] : undefined;
  const mti = flags.indexOf("--max-turns");
  const maxTurns = mti >= 0 ? Number(flags.splice(mti, 2)[1]) : 15;
  return { generations, goal, maxTurns };
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

export async function evolve(generations: number, goalArg: string | undefined, maxTurns: number) {
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
When done, reply with exactly one line starting with "LESSON:".`;
  const lesson = await agentLoop(child, system, "Make the change now.", maxTurns);

  const gate = await sh(
    `bun install && bunx tsc --noEmit && SKYNET_HOME=${JSON.stringify(join(child, ".tmp"))} bun skynet.ts --selftest`,
    child,
    300_000,
  );
  const diff = await sh("git diff --stat", child);

  if (gate.code === 0 && diff.text.trim()) {
    await sh(`git add -A && git commit -qm ${JSON.stringify(`evolve gen ${n}: ${goal}`)}`, child);
    const pull = await sh(`git pull --ff-only ${JSON.stringify(child)} HEAD`, ROOT, 60_000);
    if (pull.code !== 0) throw new Error(`ff-only pull failed: ${pull.text}`);
    learn("self", `gen ${n} promoted: ${goal}: ${lesson ?? "(no lesson)"}`);
    console.log(`gen ${n} promoted.`);
  } else {
    learn("self", `gen ${n} rejected: ${goal}: ${(gate.text || "no diff").slice(-300)}`);
    console.log(`gen ${n} rejected, left at ${child} for inspection.`);
  }

  const remaining = generations - 1;
  if (remaining > 0) {
    const argv = ["evolve", "--generations", String(remaining), "--max-turns", String(maxTurns)];
    if (goalArg) argv.push("--goal", goalArg);
    const p = Bun.spawn(["bun", join(ROOT, "skynet.ts"), ...argv], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await p.exited);
  }
}

// ---------- selftest (offline) ----------
async function selftest() {
  const assert = (c: unknown, m: string) => { if (!c) throw new Error("selftest: " + m); };
  const tmp = join(HOME, "selftest"); mkdirSync(tmp, { recursive: true });
  await Bun.write(join(tmp, "package.json"), '{"scripts":{"test":"bun test"}}');
  await Bun.write(join(tmp, "bun.lock"), "");
  assert(detectTestCmd(tmp) === "bun install && bun run test", "detect bun");
  await Bun.write(join(tmp, "package.json"), "{}");
  assert(detectTestCmd(tmp) === "bun test", "detect bare bun");
  const globDir = join(HOME, "selftest-glob"); mkdirSync(globDir, { recursive: true });
  await Bun.write(join(globDir, "add.test.ts"), "");
  assert(detectTestCmd(globDir) === "bun test", "detect glob test file, no package.json");
  assert((await sh("exit 3", tmp)).code === 3, "sh exit code");
  assert((await sh("echo hi", tmp)).text.trim() === "hi", "sh output");
  const local = await clone(tmp); assert(local === resolve(tmp), "clone local path passthrough");
  learn("selftest", "memory works"); assert(recall().includes("selftest: memory works"), "learn/recall");

  assert(nextGenDir(join(HOME, "selftest-gen-missing")) === 1, "nextGenDir empty");
  const genDir = join(HOME, "selftest-gen");
  mkdirSync(join(genDir, "1"), { recursive: true });
  mkdirSync(join(genDir, "3"), { recursive: true });
  assert(nextGenDir(genDir) === 4, "nextGenDir counter");

  const f1 = parseEvolveFlags([]);
  assert(f1.generations === 3 && f1.goal === undefined && f1.maxTurns === 15, "parseEvolveFlags defaults");
  const f2 = parseEvolveFlags(["--generations", "5", "--goal", "x y", "--max-turns", "7"]);
  assert(f2.generations === 5 && f2.goal === "x y" && f2.maxTurns === 7, "parseEvolveFlags overrides");

  assert(VERSION === "0.1.0", "--version reports 0.1.0");

  console.log("selftest ok");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--version") console.log(VERSION);
  else if (args[0] === "--selftest") await selftest();
  else if (args[0] === "evolve") {
    const { generations, goal, maxTurns } = parseEvolveFlags(args.slice(1));
    await evolve(generations, goal, maxTurns).catch((e) => { console.error(e.message); process.exit(1); });
  } else if (!args[0]) {
    console.error("usage: bun skynet.ts <git-url|path> [--max-turns N] | evolve [--generations N] [--goal text] [--max-turns N] | --selftest | --version");
    process.exit(1);
  } else {
    const mt = args.indexOf("--max-turns");
    const maxTurns = mt >= 0 ? Number(args.splice(mt, 2)[1]) : 25;
    await run(args[0], maxTurns).catch((e) => { console.error(e.message); process.exit(1); });
  }
}
