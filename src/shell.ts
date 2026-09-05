import { existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join, resolve } from "path";
import { WORK } from "./config.ts";

// cancellable delay: a bare Bun.sleep can't be cancelled, and a still-pending one keeps bun's event
// loop alive after sh() resolves (measured: a 60s sleep pinned process exit for the full 60s)
export function delay(ms: number) {
  let fire!: () => void;
  const done = new Promise<void>((res) => (fire = res));
  const t = setTimeout(fire, ms);
  return { done, cancel: () => { clearTimeout(t); fire(); } };
}

export const KILL_GRACE_MS = 2_000;

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
function pkgTestCmd(dir: string, has: (f: string) => boolean): string | null {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    pkg = null; // malformed/unparseable package.json: fall through to the other detectors
  }
  if (pkg?.scripts?.test) return has("bun.lock") || has("bun.lockb") ? "bun install && bun run test" : "npm install --silent && npm test";
  return pkg ? "bun test" : null;
}

const MARKERS: [string[], string][] = [
  [["pyproject.toml", "pytest.ini", "setup.py"], "python -m pytest -q"],
  [["Cargo.toml"], "cargo test"],
  [["go.mod"], "go test ./..."],
];

export function detectTestCmd(dir: string): string | null {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("package.json")) {
    const c = pkgTestCmd(dir, has);
    if (c) return c;
  }
  for (const [files, cmd] of MARKERS) if (files.some(has)) return cmd;
  if (has("Makefile") && /^test:/m.test(readFileSync(join(dir, "Makefile"), "utf8"))) return "make test";
  const glob = new Bun.Glob("**/*{.test.ts,.test.js,_test.ts,_test.js}");
  for (const _ of glob.scanSync({ cwd: dir })) return "bun test";
  return null;
}
