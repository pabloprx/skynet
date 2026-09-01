# skynet

## Constraints (from Pablo)
- Claude (Fable) is orchestrator/planner ONLY. Never implements. All coding via cheap sonnet subagents.
- LLM calls use the OpenRouter SDK, never the Anthropic SDK. Key in `.env` as OPENROUTER_KEY.
- Models: `openai/gpt-5.6-luna` or `z-ai/glm-5.3-flash`. Budget: $3 total on the key. Keep runs cheap.
- Runtime: bun. Single-file agent (`skynet.ts`).
- Branches: `main` = stable minimal, only deliberate promotions. `develop` = Pablo's own skynet, where evolve runs and lands. Never push evolve output to main directly.
