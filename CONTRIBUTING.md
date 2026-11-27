# Contributing to agent-ready

Thanks for helping. Bug reports, new checks, better fix suggestions, docs and support for more
languages are all welcome. Pull requests written with an AI coding agent are welcome too. This
repo is meant to be a good example of an agent-ready project, so the agent instructions in
[AGENTS.md](AGENTS.md) apply to people as well.

## Setting up

You need Node 24 for development (`nvm use` reads `.nvmrc`) and git.

```bash
git clone https://github.com/thepolytheist/agent-ready.git
cd agent-ready
npm ci          # also installs the pre-commit hook
npm run verify  # type check, lint, tests, build, and grade this repo
```

No environment variables are needed. To try grading a GitHub repository, set `GITHUB_TOKEN`
(see `.env.example`).

## Making a change

1. For anything bigger than a small fix, open an issue first so we can agree on the approach.
2. Fork the repo and create a branch from `main`.
3. Make your change with tests. Each module in `src/` has a matching file in `test/`.
4. Run `npm run verify`. It must pass; CI runs the same thing.
5. Add a line under a new "Unreleased" heading in `CHANGELOG.md` if users will notice the change.
6. Open a pull request, describe what changed and why, and fill in the checklist.

The pre-commit hook runs Biome on staged files and the type checker. `npm run format` fixes
most lint and formatting errors. To skip the hook once, use `git commit --no-verify`; CI will
still check.

### Adding or changing a check

Checks live in `src/checks.ts`. A few rules keep grades fair and stable:

- **Points total 100.** If you add a check, take its points from others in the same category.
  The test suite fails if the total changes.
- **Grades are public.** People put the badge in their READMEs, so a change that can move an
  existing repo's score needs a sentence in the PR on why the new score is fairer, and it goes
  out in a minor release.
- **Read only what's in the snapshot.** Checks are pure functions of `RepoSnapshot`. If a check
  needs a new file, add it to `WANTED_FILES` and it is fetched from GitHub and read locally
  automatically.
- **Explain every result.** `detail` is shown to users. Say what was found or what is missing,
  in plain words.
- **Add a fix.** Give new checks an entry in `TEMPLATE_FIXES` in `src/review.ts`. Snippets may
  only use commands and paths found in the snapshot; write `TODO` instead of guessing.
- Add tests that pass, partially pass and fail the check.

### Style

- TypeScript, strict mode, ESM, `.js` extensions in relative imports.
- Biome formats and lints; don't hand-format.
- No runtime dependencies. Anything exported from `src/index.ts` must run without Node APIs.
- Comments explain why, not what.

## Pull requests from forks

CI runs on pull requests from forks with read-only permissions and no access to secrets. A
maintainer approves CI runs for first-time contributors, so it may not start right away.
Changes to `.github/workflows` get extra review.

## Reporting bugs

Open an issue with the command you ran, what you expected, and what happened. Output from
`agent-ready --json` helps a lot. If a repo got a grade you think is wrong, include a link to
it or the relevant files.

Report security issues privately; see [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

1. Update `version` in `package.json` (`npm version minor --no-git-tag-version` or similar),
   update `CHANGELOG.md`, and merge to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. The Release workflow checks that the tag matches `package.json`, runs `npm run verify`,
   packs the tarball, attests its provenance, and publishes a GitHub release with the tarball
   and notes from the changelog.

Only maintainers can push `v*` tags, enforced by a tag ruleset.

## Code of conduct

Be kind and assume good intent. Harassment or personal attacks aren't tolerated, and
maintainers may remove comments or contributors that cross the line.
