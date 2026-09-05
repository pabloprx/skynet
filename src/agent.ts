import type { ChatMessages, ChatToolCall } from "@openrouter/sdk/models";
import { basename } from "path";
import { MODEL, MEMORY } from "./config.ts";
import { sh, clone, detectTestCmd } from "./shell.ts";
import { parseToolCmd, isBlockedCmd } from "./tools.ts";
import { recall, learn } from "./memory.ts";
import { chat, bashTool, claudeRun, useClaude } from "./providers/index.ts";

type Usage = Awaited<ReturnType<typeof chat>>["usage"];

function logUsage(turn: number, u: Usage): number {
  const cost = u?.cost ?? 0;
  console.log(
    `turn ${turn + 1}: prompt=${u?.promptTokens ?? "?"} cached=${u?.promptTokensDetails?.cachedTokens ?? 0} completion=${u?.completionTokens ?? "?"} cost=$${cost.toFixed(6)}`,
  );
  return cost;
}

const textOf = (content: unknown) => (typeof content === "string" ? content : "");
const lessonOf = (text: string) => text.match(/^LESSON:(.*)$/m)?.[1] ?? null;

async function runTools(dir: string, calls: ChatToolCall[], messages: ChatMessages[], childEnv?: Record<string, string>) {
  for (const c of calls) {
    const parsed = parseToolCmd(c.function.arguments);
    if ("error" in parsed) {
      // bounce malformed arguments back to the model as a tool message so it can retry
      messages.push({ role: "tool", toolCallId: c.id, content: `exit 1\nblocked: malformed tool arguments, expected {"cmd": string}` });
      continue;
    }
    const cmd = parsed.cmd;
    console.log(`$ ${cmd}`);
    const r = isBlockedCmd(cmd)
      ? { code: 1, text: "blocked: command attempts to leave the working directory, touch .env/sudo, or run a recursive evolve" }
      : await sh(cmd, dir, undefined, childEnv);
    messages.push({ role: "tool", toolCallId: c.id, content: `exit ${r.code}\n${r.text}` });
  }
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
  if (useClaude()) return claudeRun(dir, system, user, maxTurns, maxCost, childEnv);
  const messages: ChatMessages[] = [
    { role: "system", content: [{ type: "text", text: system, cacheControl: { type: "ephemeral" } }] },
    { role: "user", content: user },
  ];
  let totalCost = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const { msg, usage } = await chat(MODEL, messages, [bashTool]);
    totalCost += logUsage(turn, usage);
    if (totalCost > maxCost) {
      console.log(`budget exceeded: $${totalCost.toFixed(6)} > $${maxCost.toFixed(6)}, stopping`);
      return { lesson: null, totalCost, budgetExceeded: true };
    }
    messages.push({ role: "assistant", content: msg.content ?? null, toolCalls: msg.toolCalls } as ChatMessages);
    const text = textOf(msg.content);
    if (text) console.log(text);
    const calls: ChatToolCall[] = msg.toolCalls ?? [];
    if (!calls.length) return { lesson: lessonOf(text), totalCost, budgetExceeded: false };
    await runTools(dir, calls, messages, childEnv);
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
