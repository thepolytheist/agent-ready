import { describe, expect, it } from 'vitest';
import { detectCommands, detectEcosystems, gradeFor, runChecks, scoreReport } from '../src/checks.js';
import type { RepoSnapshot, TreeEntry } from '../src/types.js';

const blob = (name: string): TreeEntry => ({ name, type: 'blob' });
const tree = (name: string): TreeEntry => ({ name, type: 'tree' });

function snapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
	const files = overrides.files ?? {};
	const root =
		overrides.root ??
		Object.keys(files)
			.filter((p) => !p.includes('/'))
			.map(blob);
	return {
		owner: 'octo',
		name: 'repo',
		description: null,
		stars: 0,
		isArchived: false,
		defaultBranch: 'main',
		pushedAt: null,
		subtrees: {},
		workflows: [],
		...overrides,
		root,
		files
	};
}

const byId = (s: RepoSnapshot) => Object.fromEntries(runChecks(s).map((c) => [c.id, c]));

const CLAUDE_MD = `# Project notes

This is a SvelteKit app. Use Node 20.

## Commands
- \`npm install\` to install
- \`npm run dev\` to start the dev server
- \`npm test\` runs vitest
- \`npm run check\` runs svelte-check

## Conventions
Keep components small, colocate tests next to the code as *.test.ts, and never commit secrets.
Server-only code lives in src/lib/server.
`;

const README = `# Repo

## Getting started

\`\`\`bash
npm install
npm run dev
\`\`\`
`;

function polishedNode(): RepoSnapshot {
	return snapshot({
		root: [
			blob('CLAUDE.md'),
			blob('README.md'),
			blob('package.json'),
			blob('package-lock.json'),
			blob('tsconfig.json'),
			blob('eslint.config.js'),
			blob('.nvmrc'),
			blob('.env.example'),
			blob('CONTRIBUTING.md'),
			tree('.husky'),
			tree('src'),
			tree('.github')
		],
		subtrees: { src: [blob('index.ts'), blob('index.test.ts')], '.claude': [blob('settings.json')] },
		workflows: [{ name: 'ci.yml', text: 'steps:\n  - run: npm ci\n  - run: npm run lint\n  - run: npm run check\n  - run: npm test' }],
		files: {
			'CLAUDE.md': CLAUDE_MD,
			'README.md': README,
			'package.json': JSON.stringify({ scripts: { test: 'vitest run', check: 'svelte-check', lint: 'eslint .' } }),
			'tsconfig.json': '{}',
			'CONTRIBUTING.md': 'Be kind.'
		}
	});
}

describe('runChecks', () => {
	it('gives an empty repo an F', () => {
		const r = scoreReport(runChecks(snapshot({ root: [] })));
		expect(r.grade).toBe('F');
		expect(r.score).toBeLessThan(20);
	});

	it('gives a well-tooled Node repo an A+', () => {
		const checks = runChecks(polishedNode());
		const failing = checks.filter((c) => c.status !== 'pass');
		expect(failing).toEqual([]);
		expect(scoreReport(checks).grade).toBe('A+');
	});

	it('does not count the npm placeholder test script', () => {
		const s = snapshot({
			files: { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }
		});
		expect(byId(s)['tests-command'].status).toBe('fail');
		expect(byId(s)['tests-command'].detail).toMatch(/placeholder/);
	});

	it('gives Rust and Go compiler-checked credit', () => {
		const rust = byId(snapshot({ files: { 'Cargo.toml': '[package]\nname = "x"' } }));
		expect(rust['types-checker'].status).toBe('pass');
		expect(rust['tests-command'].status).toBe('pass');
		expect(rust['types-lint'].status).toBe('partial');
		const go = byId(snapshot({ files: { 'go.mod': 'module x\n\ngo 1.23\n' } }));
		expect(go['setup-runtime'].status).toBe('pass');
	});

	it('detects pytest configuration in pyproject', () => {
		const s = snapshot({
			root: [blob('pyproject.toml'), tree('tests')],
			files: {
				'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n\n[tool.pytest.ini_options]\n\n[tool.mypy]\nstrict = true\n[tool.ruff]\n'
			}
		});
		const c = byId(s);
		expect(detectEcosystems(s)).toEqual(['python']);
		expect(c['tests-command'].status).toBe('pass');
		expect(c['tests-present'].status).toBe('pass');
		expect(c['types-checker'].status).toBe('pass');
		expect(c['types-lint'].status).toBe('pass');
		expect(c['setup-runtime'].status).toBe('pass');
	});

	it('scores a thin instructions file as partial', () => {
		const c = byId(snapshot({ files: { 'AGENTS.md': 'Run make.' } }));
		expect(c['instructions-file'].status).toBe('pass');
		expect(c['instructions-substance'].status).toBe('partial');
		expect(c['instructions-commands'].status).toBe('partial');
	});

	it('penalizes huge instructions files', () => {
		const c = byId(snapshot({ files: { 'CLAUDE.md': CLAUDE_MD + 'x'.repeat(50_000) } }));
		expect(c['instructions-size'].status).toBe('fail');
	});

	it('flags committed junk and CI that never runs tests', () => {
		const c = byId(
			snapshot({
				root: [tree('node_modules'), blob('.env')],
				workflows: [{ name: 'deploy.yml', text: 'steps:\n  - run: aws s3 sync build/ s3://bucket' }]
			})
		);
		expect(c['guardrails-clean'].status).toBe('fail');
		expect(c['guardrails-clean'].detail).toContain('node_modules');
		expect(c['ci-exists'].status).toBe('pass');
		expect(c['ci-tests'].status).toBe('fail');
	});

	it('wants .env.example when docs mention env vars', () => {
		const c = byId(snapshot({ files: { 'README.md': '# X\n\nSet the GITHUB_TOKEN environment variable.' } }));
		expect(c['setup-env'].status).toBe('partial');
	});

	it('reads CLAUDE.md and AGENTS.md together when one imports the other', () => {
		const c = byId(snapshot({ files: { 'CLAUDE.md': '@AGENTS.md', 'AGENTS.md': CLAUDE_MD } }));
		expect(c['instructions-file'].detail).toContain('CLAUDE.md, AGENTS.md');
		expect(c['instructions-substance'].status).toBe('pass');
		expect(c['instructions-commands'].status).toBe('pass');
	});

	it('finds tests inside monorepo packages', () => {
		const c = byId(
			snapshot({
				root: [tree('packages')],
				subtrees: { packages: [tree('kit')], 'packages/kit': [tree('src'), tree('test')] }
			})
		);
		expect(c['tests-present'].status).toBe('pass');
		expect(c['tests-present'].detail).toBe('Found packages/kit/test/.');
	});

	it("names the repo's package manager in details", () => {
		const c = byId(
			snapshot({
				root: [blob('package.json'), blob('pnpm-lock.yaml'), blob('tsconfig.json')],
				files: { 'package.json': JSON.stringify({ scripts: { test: 'vitest', check: 'tsc' } }), 'tsconfig.json': '{}' }
			})
		);
		expect(c['tests-command'].detail).toContain('pnpm test');
		expect(c['types-checker'].detail).toContain('pnpm check');
	});

	it('always totals 100 points', () => {
		const total = runChecks(snapshot()).reduce((n, c) => n + c.max, 0);
		expect(total).toBe(100);
	});
});

describe('gradeFor', () => {
	it('maps scores to letters', () => {
		expect(gradeFor(100)).toBe('A+');
		expect(gradeFor(90)).toBe('A');
		expect(gradeFor(79)).toBe('B');
		expect(gradeFor(45)).toBe('D');
		expect(gradeFor(44)).toBe('F');
	});
});

describe('detectCommands', () => {
	it('reads Python tooling from pyproject', () => {
		const s = snapshot({
			root: [blob('pyproject.toml'), blob('uv.lock')],
			files: { 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.mypy]\n[tool.ruff]\n' }
		});
		expect(detectCommands(s)).toEqual({ install: 'uv sync', test: 'pytest', typecheck: 'mypy .', lint: 'ruff check .' });
	});

	it('falls back to make targets', () => {
		const s = snapshot({ files: { Makefile: 'test:\n\tgo test ./...\nlint:\n\tgolangci-lint run\n' } });
		expect(detectCommands(s)).toEqual({ test: 'make test', lint: 'make lint' });
	});

	it('skips the npm placeholder test script', () => {
		const s = snapshot({ files: { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) } });
		expect(detectCommands(s).test).toBeUndefined();
	});
});

describe('detectCommands for Node', () => {
	it('prefers a script named for type checking over build', () => {
		const s = snapshot({ files: { 'package.json': JSON.stringify({ scripts: { build: 'tsc -p .', typecheck: 'tsc --noEmit' } }) } });
		expect(detectCommands(s).typecheck).toBe('npm run typecheck');
		const onlyBuild = snapshot({ files: { 'package.json': JSON.stringify({ scripts: { build: 'tsc -p .' } }) } });
		expect(detectCommands(onlyBuild).typecheck).toBeUndefined();
	});
});
