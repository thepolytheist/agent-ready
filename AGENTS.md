# agent-ready

A TypeScript library and CLI that grades how ready a repository is for AI coding agents.
The score is deterministic: it comes only from `runChecks` in `src/checks.ts`. A model may
write the review text, but it never changes the score.

## Commands

- Install: `npm ci` (Node 24 for development, see `.nvmrc`; the published package supports Node 20+)
- Test: `npm test` (vitest, files in `test/`)
- Type check: `npm run typecheck`
- Lint and format check: `npm run lint` (Biome); fix with `npm run format`
- Build: `npm run build` (tsc into `dist/`)
- Everything CI runs: `npm run verify` (type check, lint, tests, build, then the CLI grades this repo and must get an A)
- Try the CLI: `npm run build && node dist/bin.js [path|owner/repo]`

Run `npm run verify` before calling a change done.

## Layout

- `src/types.ts`: shared types (`RepoSnapshot`, `CheckResult`, `Grade`, ...)
- `src/checks.ts`: every check, scoring and grades, plus `detectCommands`
- `src/review.ts`: the model prompt, schema and parser, plus `templateReview` (no model) and starter files
- `src/github.ts`: the GitHub GraphQL query and response parser
- `src/node.ts`: reads a local checkout (Node only; exported as `agent-ready/node`)
- `src/badge.ts`: the SVG badge
- `src/cli.ts`, `src/bin.ts`: the command-line tool
- `test/`: one test file per module

## Rules

- Everything exported from `src/index.ts` must run without Node APIs (it is used in browsers). Node-only code goes in `src/node.ts` or `src/cli.ts`.
- The package has no runtime dependencies. Do not add any without asking.
- Check points must total 100; `test/checks.test.ts` enforces this. Changing a check's points or
  logic changes people's published grades, so call it out in the PR and the changelog.
- Snapshots are capped (file text, subtree depth, workflow count) the same way for GitHub and
  local reads, so both give the same grade. Keep the limits in `src/github.ts` shared.
- Template fixes and starter files may only use commands and paths found in the snapshot. Write `TODO` rather than guess.
- Imports between source files use `.js` extensions (NodeNext resolution).
- Workflows in `.github/workflows` pin every action to a full commit SHA and default to read-only permissions. Keep it that way.
