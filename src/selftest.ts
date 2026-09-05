import { mkdirSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { ROOT, DEPTH, VERSION, MODEL } from "./config.ts";
import { sh, clone, detectTestCmd } from "./shell.ts";
import { learn, recall } from "./memory.ts";
import { parseToolCmd, isBlockedCmd } from "./tools.ts";
import { agentLoop } from "./agent.ts";
import { chat } from "./providers/index.ts";
import { gate, disallowedDiffFiles } from "./gate.ts";
import { nextGenDir, evolveCommitMessage, resolveGoal, parseEvolveFlags, parsePositiveIntegerFlag } from "./evolve.ts";

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
  assert(!isBlockedCmd("echo hi"), "denylist allows plain commands");
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
  await testClaudeProvider(scratch, tmp);
  await testOllamaProvider(tmp);
  testGateRules();
  await testGuards();
  // only at the top level: gate() itself calls `bun skynet.ts --selftest` on its child (one level
  // of recursion, always has), and that nested selftest run would hit this same block again if it
  // weren't gated on DEPTH - bounding it to one level, not a recursion that grows with DEPTH.
  if (DEPTH === 0) await testGate(scratch);
  console.log("selftest ok");
}
