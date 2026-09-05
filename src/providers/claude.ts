import { DEPTH } from "../config.ts";
import { delay, KILL_GRACE_MS } from "../shell.ts";

// duplicated from agent.ts's OnTurn (not imported) to avoid a providers/claude.ts -> agent.ts ->
// providers/index.ts -> providers/claude.ts import cycle.
type OnTurn = (turn: number, cost: number, ms: number, cmd?: string) => void;

function parseClaudeResult(stdout: string, maxCost: number) {
  let result: any;
  try { result = JSON.parse(stdout); } catch { throw new Error(`claude returned invalid JSON: ${stdout.slice(-2_000)}`); }
  if (result?.is_error) throw new Error(`claude reported an error: ${result.result ?? "unknown error"}`);
  const totalCost = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : 0;
  if (totalCost > maxCost) return { lesson: null, totalCost, budgetExceeded: true };
  return { lesson: result?.result ?? null, totalCost, budgetExceeded: false };
}

// the claude CLI runs its whole turn loop internally (no per-turn hook), so there is only ever
// one span to report: the entire subprocess call, reported as a single "turn" once it finishes.
export async function claudeRun(dir: string, system: string, user: string, maxTurns: number, maxCost: number, childEnv?: Record<string, string>, onTurn?: OnTurn) {
  const prompt = `${system}\n\n${user}`;
  const t0 = Date.now();
  const p = Bun.spawn(["claude", "-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", "Bash", "Read", "Edit", "Write", "Glob", "Grep", "--max-turns", String(maxTurns)], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...childEnv, SKYNET_CHILD: "1", SKYNET_DEPTH: String(DEPTH + 1) } });
  p.unref();
  const read = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();
  const output = Promise.all([read(p.stdout), read(p.stderr), p.exited]);
  const timer = delay(600_000);
  const completed = await Promise.race([output, timer.done.then(() => null)]);
  timer.cancel();
  if (completed === null) {
    p.kill(9);
    const grace = delay(KILL_GRACE_MS); await Promise.race([output, grace.done]); grace.cancel();
    throw new Error("claude timed out after 600000ms");
  }
  const [stdout, stderr, code] = completed;
  const ms = Date.now() - t0;
  if (code !== 0) throw new Error(`claude failed (exit ${code}): ${stderr || stdout}`);
  const result = parseClaudeResult(stdout, maxCost);
  onTurn?.(1, result.totalCost, ms, `claude -p --max-turns ${maxTurns}`);
  return result;
}
