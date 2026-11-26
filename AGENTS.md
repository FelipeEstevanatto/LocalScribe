# AGENTS.md

## Project organization

- Keep application source in `src/`, with one module per feature.
- Keep tests in `tests/` and benchmarks in `bench/`.
- Put shared types and helpers next to the code that owns them, not in a catch-all utility file.
- Do not edit unrelated files. This worktree is shared, so preserve changes made by other agents.
- After a change, run `bun test` and `bun run typecheck` before reporting done.

## Tooling

- Use `bun` for everything. Do not use `node`, `npm`, `npx`, or `yarn`.
- Common commands: `bun install`, `bun run dev`, `bun test`, `bun run typecheck`, `bun run build`.

## Writing style

- Never use the em dash character (the long dash). Use a comma, a period, a colon, or a hyphen instead.
- Keep prose short and direct.
