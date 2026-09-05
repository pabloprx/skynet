import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages, ChatFunctionTool } from "@openrouter/sdk/models";
import { provider } from "../config.ts";

export const bashTool: ChatFunctionTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a bash command in the repo root. Use it to read, edit (sed/heredoc) and run code.",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
    strict: true,
  },
};

// client per call, not at module load: selftest mutates process.env at runtime
function client() {
  if (provider() !== "ollama") return new OpenRouter({ apiKey: process.env.OPENROUTER_KEY });
  if (!process.env.OLLAMA_API_KEY) throw new Error("OLLAMA_API_KEY missing");
  return new OpenRouter({ apiKey: process.env.OLLAMA_API_KEY, serverURL: process.env.OLLAMA_URL ?? "https://ollama.com/v1" });
}

export async function chat(model: string, messages: ChatMessages[], tools?: ChatFunctionTool[]) {
  const res = await client().chat.send({ chatRequest: { model, messages, tools } });
  if (!("choices" in res)) throw new Error("unexpected streaming response");
  return { msg: res.choices[0]!.message, usage: res.usage };
}
