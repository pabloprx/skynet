import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages, ChatFunctionTool } from "@openrouter/sdk/models";

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
export async function chat(model: string, messages: ChatMessages[], tools?: ChatFunctionTool[]) {
  const res = await new OpenRouter({ apiKey: process.env.OPENROUTER_KEY }).chat.send({ chatRequest: { model, messages, tools } });
  if (!("choices" in res)) throw new Error("unexpected streaming response");
  return { msg: res.choices[0]!.message, usage: res.usage };
}
