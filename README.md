# skynet

A self-cloning, self-repairing, self-improving agent in one file (`skynet.ts`),
running on bun and calling LLMs through the OpenRouter SDK.

It can clone a repo and fix its failing tests, or clone itself and try to
improve its own source, gated behind tests, type checks, and a code review
before any change is promoted.

## Quickstart

```
bun install
cp .env.example .env
# set OPENROUTER_KEY in .env
bun skynet.ts --selftest
```

## Usage

```
bun skynet.ts <git-url|path> [--max-turns N]
```
Clone (or use a local path to) a repo, detect its test command, and if tests
fail, hand the failure to the LLM in a bash tool-loop until they pass. Commits
the fix and appends a lesson to memory. `--max-turns` (default 25) caps the
repair loop.

```
bun skynet.ts evolve [--generations N] [--goal "text|url|path"] [--max-turns N] [--budget usd]
```
Self-modification: clone skynet's own repo into `~/.skynet/gen/N`, let the
LLM edit it toward a goal (auto-picked if `--goal` is omitted), then run it
through the gate (see below). If the gate passes, fast-forward the change
into the parent repo and re-exec for the next generation.
- `--generations` (default 3): how many generations to run in sequence.
- `--goal`: skip auto-goal-picking and use this instead. A literal string, or
  a source to read it from: an `http(s)://` URL (fetched) or an existing
  local file path (read). See [Sharing](#sharing).
- `--max-turns` (default 15): tool-loop turn cap per generation.
- `--budget` (default 0.05): USD spend cap per generation; exceeding it fails the gate.

```
bun skynet.ts adopt <git-url> [--ref ref] [--budget usd]
```
Pull another skynet's code through the same gate, instead of an LLM
generating the diff. Clones skynet's own repo into `~/.skynet/gen/N` (same as
`evolve`), merges `ref` (default `main`) from `git-url` into it, and runs the
result through the unchanged gate. A merge conflict is rejected outright. No
LLM call, so cost is $0 unless `SKYNET_REVIEW_MODEL` is set. See
[Sharing](#sharing).
- `--ref` (default `main`): branch/ref to pull from `git-url`.
- `--budget` (default 0.05): accepted for parity with `evolve`; unused since `adopt` makes no LLM call.

```
bun skynet.ts revert
```
`git revert` the most recent commit, if it's an `evolve gen ...` commit.

```
bun skynet.ts --selftest
```
Offline self-check (no network/LLM calls). Run this after any change.

```
bun skynet.ts --version
```
Prints the version string.

## How evolve works

1. Clone the parent repo into `~/.skynet/gen/N` (next unused N).
2. Copy `.env` into the clone so the child can call OpenRouter.
3. Run `bun install`, then let the LLM edit the clone in a bash tool-loop
   toward the goal, capped by `--max-turns` and `--budget`.
4. Run the clone through the gate, in order:
   1. **no diff** - reject if nothing changed.
   2. **protected files / allowlist** - reject if the diff touches
      `smoke.test.ts`, `.env`, `.gitignore`, or `CLAUDE.md` (never allowed),
      or touches anything other than `skynet.ts` (and `package.json`/`bun.lock`,
      only when the goal itself mentions dependencies).
   3. **`bun install`** must succeed.
   4. **`bunx tsc --noEmit`** must succeed.
   5. **`bun skynet.ts --selftest`** (in the child) must pass.
   6. **smoke test** - the parent overwrites the child's `smoke.test.ts` with
      its own copy first, so the child can't weaken it, then runs
      `bun test smoke.test.ts`.
   7. **diff review** - if `SKYNET_REVIEW_MODEL` is set, an LLM reviews the
      diff against the goal and can still fail the gate.
5. If the gate passes: commit in the child, fast-forward the parent onto it,
   log a lesson to memory. If it fails: leave the child directory for
   inspection and log the rejection reason to memory.
6. If `--generations` > 1, re-exec for the next generation (spawns a fresh
   `bun skynet.ts evolve` process with the remaining count).

A running `evolve` refuses to run recursively (checked via `SKYNET_CHILD`,
which is set only inside a gated child process), so an evolving generation
can't itself spawn another evolve or repair run.

## Sharing

Two ways to spread a change between skynet instances, both through the same
gate:

- **Goal from a URL or file.** `--goal` (on `evolve`) doesn't have to be
  literal text: point it at an `http(s)://` URL and skynet fetches the body,
  or an existing local file path and it reads the file. Publish a `GOAL.md`
  in a repo or gist describing an improvement, and anyone can run
  `bun skynet.ts evolve --goal https://.../GOAL.md` to have their own LLM
  re-derive the change against their own source, gated as normal.
- **`adopt`.** Pull another skynet's actual commit and let the gate judge the
  diff directly, no LLM involved:
  `bun skynet.ts adopt https://github.com/example/skynet --ref some-branch`.

## Providers

`SKYNET_PROVIDER` picks who serves the LLM calls:
- `openrouter` (default) - OpenRouter, model default `z-ai/glm-5.3-flash`, needs `OPENROUTER_KEY`.
- `ollama` - Ollama Cloud (OpenAI-compatible), model default `qwen3-coder:480b`, needs
  `OLLAMA_API_KEY` (`OLLAMA_URL` defaults to `https://ollama.com/v1`). Ollama reports no cost, so
  cost is always $0 and `--budget` can't cap spend - only `--max-turns` bounds an ollama run.
- `claude` - shells out to the local `claude` CLI instead of an HTTP API.

## Web UI

```
bun skynet.ts ui [--port N] [--build]
```
Serves an architecture diagram (module import graph of `src/`) and a
lifecycle diagram (recent `evolve` generations) as standalone HTML, plus a
generation log table. Rendering is delegated to
[archify](https://github.com/tt-a1i/archify) (pinned commit
`5769acefcc2ebd696a4f9ed3ac9cb6cca1d75c70`), auto-cloned into
`~/.skynet/archify` on first use - requires `node` on `PATH`. `--port`
(default 4173) sets the listen port; `--build` renders once to
`~/.skynet/ui/*.html` and exits instead of serving. Set `SKYNET_ARCHIFY` to
point at an existing archify checkout to skip the auto-clone.

```
bun skynet.ts log
```
Prints the generation log (gen, event, cost, goal) parsed from
`~/.skynet/trace/gen-*.jsonl` - same data the web UI's log table shows.

## Environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_KEY` | Required. OpenRouter API key used for all LLM calls. |
| `SKYNET_MODEL` | Model for repair/evolve agent loops. Default `z-ai/glm-5.3-flash`. |
| `SKYNET_HOME` | Working directory for clones, memory, and generations. Default `~/.skynet`. |
| `SKYNET_REVIEW_MODEL` | If set, model used for the gate's diff review. If unset, diff review is skipped (always passes). |
| `SKYNET_CHILD` | Internal only. Set by the parent inside a gated child process; do not set this yourself. It disables recursive `evolve`/repair runs. |

## Cost

Measured, not estimated, per generation of `evolve`:
- `z-ai/glm-5.3-flash`: ~$0.002-0.006
- `openai/gpt-5.6-luna`: ~$0.013

Default `--budget` is $0.05/generation; a generation that exceeds it fails
the gate instead of promoting.

## Safety

This is not sandboxed. The child process (repair or evolve) runs bash
commands as your own user, with your permissions, on your filesystem.

- `isBlockedCmd` in `skynet.ts` is a heuristic denylist (blocks `cd ..`/`cd ~`/`cd /`,
  `.env`, `sudo`, and a recursive `evolve` invocation) - it is not a sandbox
  and can be worked around by a sufficiently adversarial or confused model.
- The gate's protected-file list and allowlist limit what an `evolve` diff
  can touch, but only for the files it changes, not for what commands it
  runs while trying.
- Do not run this on a machine that holds secrets, credentials, or data you
  care about. Run it in a disposable VM or container if you want real
  isolation.
