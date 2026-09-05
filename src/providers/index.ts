export { chat, bashTool } from "./openrouter.ts";
export { claudeRun } from "./claude.ts";
// function, not a module-load const: selftest flips SKYNET_PROVIDER after import
export const useClaude = () => process.env.SKYNET_PROVIDER === "claude";
