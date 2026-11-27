# agent-ready

[![agent ready](https://masonemery.com/ready/thepolytheist/agent-ready/badge.svg)](https://masonemery.com/ready/thepolytheist/agent-ready)
[![CI](https://github.com/thepolytheist/agent-ready/actions/workflows/ci.yml/badge.svg)](https://github.com/thepolytheist/agent-ready/actions/workflows/ci.yml)
[![License: 0BSD](https://img.shields.io/badge/license-0BSD-blue.svg)](LICENSE)

Grade how ready a repository is for AI coding agents. agent-ready checks whether an agent such
as Claude Code could clone your repo, learn how it works, make a change, and check that change
on its own. It looks at agent instructions, tests, type and lint checks, CI, setup docs and
guardrails, then gives a letter grade and a list of fixes.

The score is deterministic: the same files always get the same grade, with no model involved.
This is the same grader that runs [masonemery.com/ready](https://masonemery.com/ready).

```text
$ npx https://github.com/thepolytheist/agent-ready/releases/download/v0.1.0/agent-ready-0.1.0.tgz
my-app  B (76/100)
Detected: node

  Agent instructions  ████████░░  20/25
  Tests               ██████████  20/20
  Type & lint checks  ██████████  15/15
  CI                  ███████░░░  11/15
  ...
```

## Getting started

agent-ready is published as a tarball attached to each
[GitHub release](https://github.com/thepolytheist/agent-ready/releases), not on the npm
registry. npm installs it straight from the release URL, with no token needed.

Run it once without installing:

```bash
npx https://github.com/thepolytheist/agent-ready/releases/download/v0.1.0/agent-ready-0.1.0.tgz
```

Or add it to a project:

```bash
npm install --save-dev https://github.com/thepolytheist/agent-ready/releases/download/v0.1.0/agent-ready-0.1.0.tgz
```

Requires Node 20 or newer. Each release also lists the tarball's SHA-256 and has a
[build provenance attestation](#verifying-a-release).

## Using the CLI

```bash
agent-ready                     # grade the repo you're in
agent-ready ../other-repo       # grade another local checkout
agent-ready owner/repo          # grade a GitHub repo (needs GITHUB_TOKEN)
agent-ready --claude-md         # print a starter CLAUDE.md filled in from the repo
agent-ready --prompt | claude -p   # have your own agent write fixes specific to this repo
agent-ready --json              # full report for scripts
agent-ready --min-grade B       # exit 1 if the grade is below B (for CI)
```

Local checkouts are read through git, so only files git would commit count: your
`node_modules/` and local `.env` are not counted as committed junk. Outside a git repository,
everything on disk counts.

GitHub targets need a token because GitHub's GraphQL API needs one, even for public repos.
`GITHUB_TOKEN=$(gh auth token) agent-ready owner/repo` works if you use the GitHub CLI.

Without a model, the fixes are templates. agent-ready still fills them in where it can, writing
starter `CLAUDE.md` and CI files with the install, test, type-check and lint commands it found
in your repo. For fixes written specifically for your repo, `--prompt` prints a review prompt
to pipe into the agent you already use. agent-ready makes no model calls itself.

### Keeping a grade in CI

```yaml
- run: npx --yes https://github.com/thepolytheist/agent-ready/releases/download/v0.1.0/agent-ready-0.1.0.tgz --min-grade B
```

## Using the library

```ts
import { gradeSnapshot, templateReview, badgeSvg } from 'agent-ready';
import { readLocalSnapshot } from 'agent-ready/node';

const snapshot = readLocalSnapshot('.');
const { grade, score, checks } = gradeSnapshot(snapshot);
const { fixes } = templateReview(snapshot, checks);
```

The main entry point has no Node dependencies and runs in browsers and edge runtimes.

| Export                                                                      | What it does                                                              |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `gradeSnapshot(snapshot)`                                                   | Runs every check and returns score, grade, categories and checks          |
| `runChecks`, `scoreReport`, `gradeFor`, `meetsGrade`                        | The pieces of `gradeSnapshot`, and comparing grades                       |
| `detectCommands(snapshot)`                                                  | Install, run, test, type-check and lint commands found in the repo        |
| `templateReview(snapshot, checks)`                                          | Summary and up to five fixes, no model needed                             |
| `starterClaudeMd`, `starterCiWorkflow`                                      | Starter files filled in from the repo                                     |
| `REVIEW_SYSTEM_PROMPT`, `REVIEW_SCHEMA`, `buildReviewPrompt`, `parseReview` | Bring your own model: prompt, JSON schema and parser for a written review |
| `GITHUB_SNAPSHOT_QUERY`, `snapshotFromGithub`, `fetchGithubSnapshot`        | Build a snapshot from GitHub's GraphQL API in one request                 |
| `parseRepoInput`                                                            | Accepts `owner/repo`, GitHub URLs and SSH remotes                         |
| `badgeSvg(grade)`                                                           | A shields-style SVG badge                                                 |
| `readLocalSnapshot(dir)` (`agent-ready/node`)                               | Build a snapshot from a local checkout                                    |

## What gets checked

| Category           | Check                                             | Points |
| ------------------ | ------------------------------------------------- | -----: |
| Agent instructions | `CLAUDE.md`, `AGENTS.md` or similar exists        |     10 |
|                    | Instructions have substance (300+ characters)     |      5 |
|                    | Instructions say how to build and test            |      7 |
|                    | Instructions are a sensible size (under 40 KB)    |      3 |
| Tests              | One command runs the tests                        |     10 |
|                    | Test files exist                                  |     10 |
| Type & lint checks | Type checking                                     |      8 |
|                    | Linter or formatter                               |      7 |
| CI                 | CI is set up                                      |      5 |
|                    | CI runs the tests                                 |      6 |
|                    | CI runs type or lint checks                       |      4 |
| Setup clarity      | README explains setup                             |      5 |
|                    | Dependencies are locked                           |      4 |
|                    | Runtime version is pinned                         |      3 |
|                    | Environment variables are documented              |      3 |
| Guardrails         | Contribution guide                                |      3 |
|                    | Pre-commit hooks                                  |      3 |
|                    | No committed build output, dependencies or `.env` |      4 |

Grades: A+ 95, A 90, A- 85, B+ 80, B 75, B- 70, C+ 65, C 60, C- 55, D 45, F below 45.

Node, Python, Rust and Go are recognized. Other languages still get credit for instructions,
CI, docs and guardrails.

## Badge

Grade a public repo at [masonemery.com/ready](https://masonemery.com/ready) to get a README badge:

```markdown
[![agent ready](https://masonemery.com/ready/OWNER/REPO/badge.svg)](https://masonemery.com/ready/OWNER/REPO)
```

## Verifying a release

Release tarballs are built in GitHub Actions and signed with a build provenance attestation:

```bash
gh attestation verify agent-ready-0.1.0.tgz --repo thepolytheist/agent-ready
```

## Contributing

Contributions are welcome, from people and agents alike. See [CONTRIBUTING.md](CONTRIBUTING.md).
For security issues, see [SECURITY.md](SECURITY.md).

## License

[0BSD](LICENSE): do anything you like with it. No attribution required.
