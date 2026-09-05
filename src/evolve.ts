import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { HOME, MODEL, DEPTH, ROOT } from "./config.ts";
import { sh } from "./shell.ts";
import { recall, learn } from "./memory.ts";
import { gate, ALWAYS_PROTECTED_FILES } from "./gate.ts";
import { agentLoop } from "./agent.ts";
import { chat } from "./providers/index.ts";
import { appendTrace } from "./trace.ts";

export function nextGenDir(genRoot: string): number {
  if (!existsSync(genRoot)) return 1;
  const nums = readdirSync(genRoot).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

// subject <=72 chars (git convention), full goal always in the body; written to a file and
// committed with `git commit -F` so backticks/quotes in the goal never round-trip through bash -lc.
export function evolveCommitMessage(n: number, goal: string): string {
  const full = `evolve gen ${n}: ${goal}`;
  const subject = full.length <= 72 ? full : full.slice(0, 69) + "...";
  return `${subject}\n\n${goal}`;
}

// ---------- goal sources ----------
// a goal can be literal text, a path to a local file, or an http(s) URL (e.g. a GOAL.md a repo
// or gist publishes) so any skynet can re-derive a published change against its own source.
export function parsePositiveIntegerFlag(flag: string, raw: string | undefined): number {
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer (got ${raw ?? "missing value"})`);
  }
  return value;
}

export function parseBudgetFlag(flags: string[]): number {
  const bi = flags.indexOf("--budget");
  if (bi < 0) return 0.05;
  const raw = flags.splice(bi, 2)[1];
  const budget = Number(raw);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget must be a positive number (got ${raw ?? "missing value"})`);
  return budget;
}

export function parseEvolveFlags(argv: string[]) {
  const flags = [...argv];
  const gi = flags.indexOf("--generations");
  const generations = gi >= 0 ? parsePositiveIntegerFlag("--generations", flags.splice(gi, 2)[1]) : 3;
  const goi = flags.indexOf("--goal");
  const goal = goi >= 0 ? flags.splice(goi, 2)[1] : undefined;
  const mti = flags.indexOf("--max-turns");
  const maxTurns = mti >= 0 ? parsePositiveIntegerFlag("--max-turns", flags.splice(mti, 2)[1]) : 15;
  const budget = parseBudgetFlag(flags);
  return { generations, goal, maxTurns, budget };
}

export async function resolveGoal(value: string): Promise<string> {
  if (/^https?:\/\//i.test(value)) {
    const res = await fetch(value);
    if (!res.ok) throw new Error(`resolveGoal: fetch failed (${res.status}) for ${value}`);
    return (await res.text()).trim();
  }
  if (existsSync(value)) return readFileSync(value, "utf8").trim();
  return value;
}

export async function revert(root: string = ROOT) {
  const subj = (await sh("git log -1 --pretty=%s", root)).text.trim();
  if (!subj.startsWith("evolve gen")) {
    console.error("HEAD is not an evolve commit");
    process.exit(1);
  }
  const r = await sh("git revert --no-edit HEAD", root, 60_000);
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
  const files = ["skynet.ts", ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: childDir })].sort();
  const src = files.map((f) => `--- ${f} ---\n${readFileSync(join(childDir, f), "utf8")}`).join("\n");
  const { msg } = await chat(MODEL(), [
    {
      role: "user",
      content: `You are skynet, choosing your own next self-improvement.\nLessons so far:\n${recall() || "(none)"}\n\nCurrent source (skynet.ts is a thin entry; the code lives in the files under src/):\n${src}\n\nReply with exactly one line: one small, concrete improvement to make to the files under src/.`,
    },
  ]);
  const text = (msg.content as string) ?? "";
  return text.trim().split("\n")[0]!;
}

// commit any pre-existing dirty state in ROOT *before* cloning, so the child (and its later
// gen commit) descends from it — otherwise the child's commit and a post-clone pre-evolve
// commit are siblings and the ff-only pull in promote() can never fast-forward.
export async function prepareChild() {
  await ensureRepo(ROOT);
  const dirty0 = await sh("git status --porcelain", ROOT);
  if (dirty0.text.trim()) await sh(`git add -A && git commit -qm "chore: pre-evolve"`, ROOT);

  const genRoot = join(HOME, "gen");
  mkdirSync(genRoot, { recursive: true });
  const n = nextGenDir(genRoot);
  const child = join(genRoot, String(n));

  const cl = await sh(`git clone ${JSON.stringify(ROOT)} ${JSON.stringify(child)}`, genRoot, 300_000);
  if (cl.code !== 0) throw new Error(`self-clone failed: ${cl.text}`);
  return { n, child };
}

export async function promote(child: string, n: number, goal: string) {
  const msgPath = join(tmpdir(), `skynet-commit-msg-${n}-${Date.now()}.txt`);
  await Bun.write(msgPath, evolveCommitMessage(n, goal));
  await sh(`git add -A && git commit -qF ${JSON.stringify(msgPath)}`, child);
  const pull = await sh(`git pull --ff-only ${JSON.stringify(child)} HEAD`, ROOT, 60_000);
  if (pull.code !== 0) throw new Error(`ff-only pull failed: ${pull.text}`);
}

async function spawnNextGen(remaining: number, maxTurns: number, budget: number, goalArg: string | undefined) {
  const argv = ["evolve", "--generations", String(remaining), "--max-turns", String(maxTurns), "--budget", String(budget)];
  if (goalArg) argv.push("--goal", goalArg);
  // same DEPTH: the next gen is a sibling continuation (bounded by --generations), not a nested
  // spawn; DEPTH+1 here made gen 3 of a default run always fail gate's depth-capped selftest.
  const p = Bun.spawn(["bun", join(ROOT, "skynet.ts"), ...argv], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"], env: { ...process.env, SKYNET_DEPTH: String(DEPTH) } });
  process.exit(await p.exited);
}

export async function evolve(generations: number, goalArg: string | undefined, maxTurns: number, budget: number) {
  if (process.env.SKYNET_CHILD) throw new Error("evolve: refusing to run recursively inside a child (SKYNET_CHILD is set)");
  const { n, child } = await prepareChild();
  if (existsSync(join(ROOT, ".env"))) await Bun.write(join(child, ".env"), readFileSync(join(ROOT, ".env")));
  const inst = await sh("bun install", child, 300_000);
  if (inst.code !== 0) throw new Error(`bun install failed in ${child}: ${inst.text}`);

  const goal = goalArg !== undefined ? await resolveGoal(goalArg) : await pickGoal(child);
  console.log(`gen ${n} goal: ${goal}`);
  appendTrace(n, "start", { goal });

  const system = `You are skynet, improving your own source at ${child}. Goal: ${goal}.
Constraints: only edit files inside this directory, never touch .env, keep "bun skynet.ts --selftest", "bunx tsc --noEmit" and "bunx eslint --no-inline-config ." passing, add one selftest assertion covering your change, do not commit.
Never touch these files: ${ALWAYS_PROTECTED_FILES.join(", ")} — any change to them causes automatic rejection. package.json and bun.lock are also rejected unless this goal explicitly asks for a dependency change.
Never run "bun skynet.ts evolve" or "bun skynet.ts <target>" — this is a self-modification task, not an evolve/repair run; that is blocked and will fail.
When done, reply with exactly one line starting with "LESSON:".`;
  const { lesson, totalCost, budgetExceeded } = await agentLoop(child, system, "Make the change now.", maxTurns, budget, { SKYNET_CHILD: "1", SKYNET_DEPTH: String(DEPTH + 1) });
  console.log(`gen ${n} total cost: $${totalCost.toFixed(6)}`);

  const gateResult = budgetExceeded
    ? { ok: false, reason: `budget exceeded ($${totalCost.toFixed(6)} > $${budget.toFixed(6)})` }
    : await gate(child, n, goal);

  if (gateResult.ok) {
    await promote(child, n, goal);
    learn("self", `gen ${n} promoted: ${goal}: ${lesson ?? "(no lesson)"}`);
    console.log(`gen ${n} promoted.`);
    appendTrace(n, "promoted", { cost: totalCost });
  } else {
    learn("self", `gen ${n} rejected: ${goal}: ${gateResult.reason}`);
    console.log(`gen ${n} rejected (${gateResult.reason}), left at ${child} for inspection.`);
    appendTrace(n, "rejected", { reason: gateResult.reason, cost: totalCost });
  }

  const remaining = generations - 1;
  if (remaining > 0) await spawnNextGen(remaining, maxTurns, budget, goalArg);
}
