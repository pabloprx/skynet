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
bun skynet.ts evolve [--generations N] [--goal "text"] [--max-turns N] [--budget usd]
```
Self-modification: clone skynet's own repo into `~/.skynet/gen/N`, let the
LLM edit it toward a goal (auto-picked if `--goal` is omitted), then run it
through the gate (see below). If the gate passes, fast-forward the change
into the parent repo and re-exec for the next generation.
- `--generations` (default 3): how many generations to run in sequence.
- `--goal`: skip auto-goal-picking and use this text instead.
- `--max-turns` (default 15): tool-loop turn cap per generation.
- `--budget` (default 0.05): USD spend cap per generation; exceeding it fails the gate.

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
