import { mkdirSync, chmodSync, existsSync, statSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { ROOT, DEPTH, VERSION, MODEL } from "./config.ts";
import { sh, clone, detectTestCmd } from "./shell.ts";
import { learn, recall } from "./memory.ts";
import { parseToolCmd, isBlockedCmd } from "./tools.ts";
import { agentLoop } from "./agent.ts";
import { chat } from "./providers/index.ts";
import { gate, disallowedDiffFiles, diffHasSymlink } from "./gate.ts";
import { nextGenDir, evolveCommitMessage, resolveGoal, parseEvolveFlags, parsePositiveIntegerFlag } from "./evolve.ts";
import { appendTrace, readTraceFiles, genSummaries } from "./trace.ts";
import { buildArchitectureIR, buildLifecycleIR } from "./ui/ir.ts";

const assert = (c: unknown, m: string) => { if (!c) throw new Error("selftest: " + m); };

async function testShell(scratch: string, tmp: string) {
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
}

function testFlags() {
  assert(VERSION === "0.1.0", "--version reports 0.1.0");
  const f1 = parseEvolveFlags([]);
  assert(f1.generations === 3 && f1.goal === undefined && f1.maxTurns === 15 && f1.budget === 0.05, "parseEvolveFlags defaults");
  const f2 = parseEvolveFlags(["--generations", "5", "--goal", "x y", "--max-turns", "7", "--budget", "0.2"]);
  assert(f2.generations === 5 && f2.goal === "x y" && f2.maxTurns === 7 && f2.budget === 0.2, "parseEvolveFlags overrides");
  assert(["0", "-1", "nope", "Infinity"].every((n) => { try { parsePositiveIntegerFlag("--max-turns", n); return false; } catch { return true; } }), "numeric flags reject invalid values");
  assert(["0", "-1", "nope"].every((n) => { try { parseEvolveFlags(["--budget", n]); return false; } catch { return true; } }), "--budget rejects invalid values");
}

async function testEvolve(scratch: string) {
  assert(nextGenDir(join(scratch, "gen-missing")) === 1, "nextGenDir empty");
  const genDir = join(scratch, "gen");
  mkdirSync(join(genDir, "1"), { recursive: true });
  mkdirSync(join(genDir, "3"), { recursive: true });
  assert(nextGenDir(genDir) === 4, "nextGenDir counter");

  const cmsg = evolveCommitMessage(1, "a".repeat(100));
  assert(cmsg.split("\n")[0]!.length <= 72, "commit subject capped at 72 chars");
  assert(cmsg.includes("a".repeat(100)), "commit body carries the full goal");

  assert((await resolveGoal("just some text")) === "just some text", "resolveGoal literal passthrough");
  const goalFile = join(scratch, "goal.txt");
  await Bun.write(goalFile, "goal from file\n");
  assert((await resolveGoal(goalFile)) === "goal from file", "resolveGoal reads a file");
}

function testTools() {
  const pc = parseToolCmd('{"cmd":"ls"}');
  assert("cmd" in pc && pc.cmd === "ls", "parseToolCmd accepts valid cmd");
  assert("error" in parseToolCmd('"{nope"'), "parseToolCmd rejects unparseable args");
  assert("error" in parseToolCmd('{"x":1}'), "parseToolCmd rejects missing/non-string cmd");

  assert(isBlockedCmd("cd .. && ls"), "denylist blocks cd ..");
  assert(isBlockedCmd("cat .env"), "denylist blocks .env");
  assert(isBlockedCmd("bun skynet.ts evolve --goal x"), "denylist blocks recursive evolve");
  assert(isBlockedCmd("cat .git/config"), "denylist blocks reading .git/config");
  assert(isBlockedCmd("git remote get-url origin"), "denylist blocks git remote (ROOT path recovery)");
  assert(!isBlockedCmd("echo hi"), "denylist allows plain commands");
}

function testDiffHasSymlink() {
  const noneRaw = ":100644 100644 aaa bbb M\tsrc/foo.ts\n:000000 100644 000 ccc A\tsrc/bar.ts";
  assert(!diffHasSymlink(noneRaw), "diffHasSymlink: false on plain file changes");
  const symlinkRaw = ":000000 120000 000 ddd A\tsrc/evil.ts";
  assert(diffHasSymlink(symlinkRaw), "diffHasSymlink: true when a diff stages a symlink");
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, vars);
  try { await fn(); }
  finally { for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

async function testClaudeProvider(scratch: string, tmp: string) {
  const fakeBin = join(scratch, "fake-bin"); mkdirSync(fakeBin, { recursive: true });
  const fakeClaude = join(fakeBin, "claude");
  await Bun.write(fakeClaude, `#!/bin/sh\nprintf '%s\n' '{"result":"local lesson","total_cost_usd":0.0123,"is_error":false}'\n`);
  chmodSync(fakeClaude, 0o755);
  await withEnv({ SKYNET_PROVIDER: "claude", PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, async () => {
    const localResult = await agentLoop(tmp, "system prompt", "user prompt", 2);
    assert(localResult.lesson === "local lesson" && localResult.totalCost === 0.0123, "claude provider uses local binary");
  });
}

async function testOllamaProvider(tmp: string) {
  const savedKey = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    await withEnv({ SKYNET_PROVIDER: "ollama" }, async () => {
      let threw = false;
      try { await chat(MODEL(), [{ role: "user", content: "hi" }]); } catch (e) { threw = String(e).includes("OLLAMA_API_KEY missing"); }
      assert(threw, "ollama provider throws when OLLAMA_API_KEY is missing");
    });
  } finally {
    if (savedKey !== undefined) process.env.OLLAMA_API_KEY = savedKey;
  }

  let seenPath = "";
  let seenAuth = "";
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      seenPath = new URL(req.url).pathname;
      seenAuth = req.headers.get("authorization") ?? "";
      return Response.json({
        id: "mock", object: "chat.completion", created: 0, model: "qwen3-coder:480b", system_fingerprint: null,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "LESSON:mock" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    await withEnv({ SKYNET_PROVIDER: "ollama", OLLAMA_API_KEY: "test", OLLAMA_URL: `http://127.0.0.1:${server.port}/v1` }, async () => {
      const r = await agentLoop(tmp, "sys", "user", 2);
      assert(r.lesson === "mock", `ollama provider parses mock lesson (got ${r.lesson})`);
      assert(r.totalCost === 0, `ollama cost stays 0 (got ${r.totalCost})`);
    });
  } finally {
    server.stop(true);
  }
  assert(seenPath === "/v1/chat/completions", `ollama request path is /v1/chat/completions (got ${seenPath})`);
  assert(seenAuth === "Bearer test", `ollama request carries bearer auth (got ${seenAuth})`);
}

function testGateRules() {
  assert(disallowedDiffFiles(["smoke.test.ts"], "fix bug").length === 1, "smoke.test.ts always disallowed");
  assert(disallowedDiffFiles(["eslint.config.js"], "fix bug").length === 1, "eslint.config.js always disallowed");
  assert(disallowedDiffFiles(["skynet.ts"], "fix bug").length === 0, "skynet.ts allowed");
  assert(disallowedDiffFiles(["src/foo.ts", "src/agent.ts"], "fix bug").length === 0, "src/ allowed");
  assert(disallowedDiffFiles(["package.json"], "fix bug").length === 1, "package.json disallowed without a deps goal");
  assert(disallowedDiffFiles(["package.json"], "add a new dependency").length === 0, "package.json allowed when goal mentions deps");
  assert(disallowedDiffFiles(["random-new-file.ts"], "fix bug").length === 1, "unrelated new file disallowed");
}

async function testGuards() {
  // SKYNET_CHILD guard: evolve()/run() must refuse to run recursively inside a child, so a
  // self-modifying agent can't spend budget on (or promote via) a nested evolve/repair run.
  const guardEvolve = await sh("SKYNET_CHILD=1 bun skynet.ts evolve --generations 1 --max-turns 1", ROOT, 20_000);
  assert(guardEvolve.code !== 0 && guardEvolve.text.includes("SKYNET_CHILD"), "evolve refuses to run when SKYNET_CHILD is set");
  const guardRun = await sh("SKYNET_CHILD=1 bun skynet.ts /nonexistent-target-xyz", ROOT, 20_000);
  assert(guardRun.code !== 0 && guardRun.text.includes("SKYNET_CHILD"), "run refuses to run when SKYNET_CHILD is set");
  // SKYNET_DEPTH guard: a spawn past depth 2 must refuse before doing any work.
  const r = await sh("SKYNET_DEPTH=3 bun skynet.ts --version", ROOT, 20_000);
  assert(r.code !== 0 && r.text.includes("nesting depth exceeded"), "SKYNET_DEPTH>2 refuses to run");
}

async function testArchifyRender(scratch: string, arch: unknown, life: unknown) {
  const archifyDir = process.env.SKYNET_ARCHIFY;
  const cli = archifyDir ? join(archifyDir, "archify", "bin", "archify.mjs") : "";
  const hasNode = (await sh("node --version", scratch, 10_000)).code === 0;
  if (!archifyDir || !hasNode || !existsSync(cli)) return void console.log("skip: archify");

  const dir = join(scratch, "ui-render");
  mkdirSync(dir, { recursive: true });
  const archJson = join(dir, "architecture.json");
  const lifeJson = join(dir, "lifecycle.json");
  await Bun.write(archJson, JSON.stringify(arch));
  await Bun.write(lifeJson, JSON.stringify(life));

  // "validate architecture" runs the same artifact-check receipt as "deliver" and hits the same
  // 64KB truncation on this input's many warnings, even on the pristine clone - skip it, "render"
  // below is what actually needs to work. lifecycle's receipt is small enough to stay validated.
  const vl = await sh(`node ${JSON.stringify(cli)} validate lifecycle ${JSON.stringify(lifeJson)} --json`, dir, 30_000);
  assert(vl.code === 0, `archify validate lifecycle exit 0: ${vl.text.slice(-500)}`);

  const archHtml = join(dir, "architecture.html");
  const lifeHtml = join(dir, "lifecycle.html");
  const da = await sh(`node ${JSON.stringify(cli)} render architecture ${JSON.stringify(archJson)} ${JSON.stringify(archHtml)} --quality standard`, dir, 30_000);
  assert(da.code === 0, `archify render architecture exit 0: ${da.text.slice(-500)}`);
  const dl = await sh(`node ${JSON.stringify(cli)} render lifecycle ${JSON.stringify(lifeJson)} ${JSON.stringify(lifeHtml)} --quality standard`, dir, 30_000);
  assert(dl.code === 0, `archify render lifecycle exit 0: ${dl.text.slice(-500)}`);

  assert(statSync(archHtml).size > 10_000, "architecture.html > 10KB");
  assert(statSync(lifeHtml).size > 10_000, "lifecycle.html > 10KB");
}

async function testUi(scratch: string) {
  const arch = buildArchitectureIR(ROOT);
  assert(arch.components.length >= 10, `buildArchitectureIR finds >= 10 components (got ${arch.components.length})`);
  assert(arch.connections.some((c) => c.from === "src_agent" && c.to === "src_providers_index"), "connection agent.ts -> providers/index.ts exists");

  // SKYNET_HOME is baked into config.ts at import time, so a tmp "home" for this test means an
  // explicit trace dir passed to the helpers directly, not a process.env mutation (a no-op here).
  const trDir = join(scratch, "ui-trace-home", "trace");
  appendTrace(1, "start", { goal: "add cache" }, trDir);
  appendTrace(1, "promoted", { cost: 0.02 }, trDir);
  const files = readTraceFiles(trDir);
  assert(files.length === 1 && files[0]!.events.length === 2, "trace: append/read round-trip");

  // a still-running gen (start + turn events, no promoted/rejected) with a 300-char goal: exercises
  // both the "turn" trace event and the lifecycle sublabel-overflow fix in the same case.
  const longGoal = "x".repeat(300);
  appendTrace(2, "start", { goal: longGoal }, trDir);
  appendTrace(2, "turn", { turn: 1, cost: 0.1 }, trDir);
  appendTrace(2, "turn", { turn: 2, cost: 0.2 }, trDir);
  appendTrace(2, "turn", { turn: 3, cost: 0.3 }, trDir);

  // simulate a hard kill (SIGINT) mid-appendFileSync: the torn final line used to make
  // readTraceFiles/genSummaries/buildLifecycleIR throw forever until the file was hand-deleted.
  const gen2File = join(trDir, "gen-2.jsonl");
  const gen2EventsBefore = readTraceFiles(trDir).find((f) => f.gen === 2)!.events.length;
  // torn line exactly as a hard kill mid-append would leave it: valid prefix, no closing brace
  appendFileSync(gen2File, '{"t":"' + new Date().toISOString() + ',"gen":2,"event":"turn"\n');
  const tornFiles = readTraceFiles(trDir);
  const gen2After = tornFiles.find((f) => f.gen === 2)!.events;
  assert(tornFiles.length === 2 && gen2After.length === gen2EventsBefore && gen2After.every((e) => typeof e === "object" && e !== null), "trace: torn final line skipped, only well-formed events returned");
  const tornSummaries = genSummaries(trDir);
  assert(tornSummaries.length === 2 && tornSummaries.every((g) => g.status === "running" || g.status === "promoted" || g.status === "rejected"), "genSummaries: survives a torn final trace line without throwing");

  const summaries = genSummaries(trDir);
  assert(summaries.length === 2, `genSummaries: one row per gen (got ${summaries.length})`);
  const gen2 = summaries.find((s) => s.gen === 2)!;
  assert(gen2.status === "running" && gen2.turns === 3 && gen2.cost === 0.3, `genSummaries: gen 2 running (turn 3), cost 0.3 (got ${JSON.stringify(gen2)})`);
  const gen1 = summaries.find((s) => s.gen === 1)!;
  assert(gen1.status === "promoted" && gen1.cost === 0.02, `genSummaries: gen 1 promoted, cost 0.02 (got ${JSON.stringify(gen1)})`);

  const life = buildLifecycleIR(trDir);
  assert(life.states.length === 3, `buildLifecycleIR has 3 gen stages incl. summary (got ${life.states.length})`);
  const runningState = life.states.find((s) => s.id === "gen2")!;
  assert(runningState.type === "active" && runningState.label.includes("running"), `lifecycle: running gen has a distinct label (got ${JSON.stringify(runningState)})`);
  assert(runningState.sublabel.length <= 30, `lifecycle: sublabel fits archify's legible-minimum budget (got ${runningState.sublabel.length} chars: "${runningState.sublabel}")`);

  await testArchifyRender(scratch, arch, life);
}

async function testUiServer() {
  const { startServer, maybeStartUi, DEFAULT_UI_PORT } = await import("./ui/server.ts");
  const s = startServer(0);
  try {
    assert(typeof s.port === "number" && s.port > 0, `startServer binds an ephemeral port (got ${s.port})`);
    await withEnv({ SKYNET_UI_PORT: String(s.port) }, async () => {
      maybeStartUi(true); // port already taken -> must report the URL without throwing
    });
    await withEnv({ SKYNET_CHILD: "1" }, async () => {
      maybeStartUi(true); // child guard -> no-op, must not throw
    });
    assert(DEFAULT_UI_PORT === 3333, `default UI port is 3333 (got ${DEFAULT_UI_PORT})`);
  } finally {
    s.stop(true);
  }
}

// gate: offline test against throwaway clones under tmpdir, calling gate() directly - never
// spawns `skynet.ts adopt/evolve/run` from inside selftest. That used to recurse unboundedly
// (selftest -> adopt -> gate -> selftest -> adopt -> ...); SKYNET_DEPTH now also caps gate()'s
// own nested selftest/smoke spawns below, but this test no longer relies on that cap to halt.
// copy the actual working tree (not `git clone`, which would only see committed history and
// miss whatever fix is being tested right now), then commit it as the child's base so the
// harmless/bad edits below show up as gate()'s uncommitted diff, same shape a real evolve/adopt leaves.
async function seedChild(dir: string) {
  mkdirSync(dir, { recursive: true });
  assert((await sh(`(cd ${JSON.stringify(ROOT)} && tar cf - --exclude=.git --exclude=node_modules .) | tar xf -`, dir, 60_000)).code === 0, "gate: seed child working tree");
  assert((await sh(`git init -q && git add -A && git commit -qm "chore: base"`, dir)).code === 0, "gate: commit child base");
}

async function testGate(scratch: string) {
  const lint = await sh("bunx eslint --no-inline-config .", ROOT, 120_000);
  assert(lint.code === 0, `eslint clean: ${lint.text.slice(-500)}`);

  const gchild = join(scratch, "gate-child-ok");
  await seedChild(gchild);
  assert((await sh(`ln -s ${JSON.stringify(join(ROOT, "node_modules"))} ${JSON.stringify(join(gchild, "node_modules"))}`, scratch)).code === 0, "gate: link node_modules");
  await sh(`echo '// gate-selftest: harmless' >> skynet.ts`, gchild);
  const okResult = await gate(gchild, 999_001, "harmless comment");
  assert(okResult.ok, `gate: harmless diff should pass: ${okResult.reason}`);

  const bchild = join(scratch, "gate-child-bad");
  await seedChild(bchild);
  await sh(`echo '// gate-selftest: bad' >> smoke.test.ts`, bchild);
  const badResult = await gate(bchild, 999_002, "harmless comment");
  assert(!badResult.ok && badResult.reason.includes("touched disallowed files"), `gate: touching smoke.test.ts should reject: ${badResult.reason}`);

  // untracked files must be visible to the allowlist (plain `git diff` would miss them)
  const uchild = join(scratch, "gate-child-untracked");
  await seedChild(uchild);
  await Bun.write(join(uchild, "bunfig.toml"), "[test]\npreload = []\n");
  const untrackedResult = await gate(uchild, 999_003, "harmless comment");
  assert(!untrackedResult.ok && untrackedResult.reason.includes("bunfig.toml"), `gate: untracked root file should reject: ${untrackedResult.reason}`);

  // a symlink under src/ passes the path-only allowlist, so it needs its own dedicated check
  const schild = join(scratch, "gate-child-symlink");
  await seedChild(schild);
  assert((await sh("ln -s ../../../etc/passwd src/evil-link.ts", schild)).code === 0, "gate: create symlink under src/");
  const symlinkResult = await gate(schild, 999_004, "harmless comment");
  assert(!symlinkResult.ok && symlinkResult.reason.includes("symlink"), `gate: symlink in diff should reject: ${symlinkResult.reason}`);
}

// ---------- selftest (offline) ----------
export async function selftest() {
  // scratch dirs live under the OS tmpdir, never under HOME/cwd — HOME may be a caller-chosen
  // relative path (e.g. gate() setting SKYNET_HOME for an isolated run) and these fixtures must
  // never land inside a git working tree and get swept up by a later `git add -A`.
  const scratch = join(tmpdir(), `skynet-selftest-${process.pid}-${Date.now()}`);
  const tmp = join(scratch, "pkg"); mkdirSync(tmp, { recursive: true });
  await testShell(scratch, tmp);
  testFlags();
  await testEvolve(scratch);
  testTools();
  testDiffHasSymlink();
  await testClaudeProvider(scratch, tmp);
  await testOllamaProvider(tmp);
  testGateRules();
  await testGuards();
  await testUi(scratch);
  await testUiServer();
  // only at the top level: gate() itself calls `bun skynet.ts --selftest` on its child (one level
  // of recursion, always has), and that nested selftest run would hit this same block again if it
  // weren't gated on DEPTH - bounding it to one level, not a recursion that grows with DEPTH.
  if (DEPTH === 0) await testGate(scratch);
  console.log("selftest ok");
}
