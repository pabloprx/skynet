// External smoke test: the parent copies this file over the child's before gating a generation
// and runs `bun test smoke.test.ts`. The child must never be able to weaken it (see gate() in
// skynet.ts, which rejects any generation that touches this file at all before it even runs).
import { test, expect } from "bun:test";
import { mkdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import {
  detectTestCmd,
  sh,
  clone,
  learn,
  recall,
  nextGenDir,
  parseEvolveFlags,
  isBlockedCmd,
} from "./skynet.ts";

const TMP = join(tmpdir(), `skynet-smoke-${process.pid}-${Date.now()}`);
mkdirSync(TMP, { recursive: true });

test("detectTestCmd: package.json + bun.lock -> bun install && bun run test", async () => {
  const dir = join(TMP, "d1"); mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "package.json"), '{"scripts":{"test":"bun test"}}');
  await Bun.write(join(dir, "bun.lock"), "");
  expect(detectTestCmd(dir)).toBe("bun install && bun run test");
});

test("detectTestCmd: bare package.json -> bun test", async () => {
  const dir = join(TMP, "d2"); mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, "package.json"), "{}");
  expect(detectTestCmd(dir)).toBe("bun test");
});

test("detectTestCmd: no markers -> null", () => {
  const dir = join(TMP, "d3"); mkdirSync(dir, { recursive: true });
  expect(detectTestCmd(dir)).toBeNull();
});

test("sh: exit code and output", async () => {
  expect((await sh("exit 7", TMP)).code).toBe(7);
  expect((await sh("echo hello", TMP)).text.trim()).toBe("hello");
});

test("clone: local path passthrough", async () => {
  const dir = join(TMP, "d4"); mkdirSync(dir, { recursive: true });
  expect(await clone(dir)).toBe(resolve(dir));
});

test("learn/recall", () => {
  const marker = `smoke-${Date.now()}`;
  learn("smoke", marker);
  expect(recall()).toContain(marker);
});

test("nextGenDir", () => {
  expect(nextGenDir(join(TMP, "gen-empty"))).toBe(1);
  const gen = join(TMP, "gen-nums");
  mkdirSync(join(gen, "1"), { recursive: true });
  mkdirSync(join(gen, "5"), { recursive: true });
  expect(nextGenDir(gen)).toBe(6);
});

test("parseEvolveFlags: defaults and overrides", () => {
  const d = parseEvolveFlags([]);
  expect(d.generations).toBe(3);
  expect(d.maxTurns).toBe(15);
  expect(d.budget).toBe(0.05);
  const o = parseEvolveFlags(["--generations", "2", "--budget", "0.1"]);
  expect(o.generations).toBe(2);
  expect(o.budget).toBe(0.1);
});

test("bash denylist blocks dir escape, .env and recursive evolve", () => {
  expect(isBlockedCmd("cd .. && rm -rf x")).toBe(true);
  expect(isBlockedCmd("cat .env")).toBe(true);
  expect(isBlockedCmd("bun skynet.ts evolve --goal x")).toBe(true);
  expect(isBlockedCmd("echo hi")).toBe(false);
});

test("cli: --version exits 0", async () => {
  expect((await sh("bun skynet.ts --version", ".")).code).toBe(0);
});

test("cli: --selftest exits 0", async () => {
  const home = join(TMP, "selftest-home");
  const r = await sh(`SKYNET_HOME=${JSON.stringify(home)} bun skynet.ts --selftest`, ".", 60_000);
  expect(r.code).toBe(0);
});
