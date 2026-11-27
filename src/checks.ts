// Deterministic grading for agent readiness. The score comes only from these checks, so a
// repo's badge is stable and free to recompute; a model (or the template fallback) only writes
// the notes and fix list.
import type { CategoryId, CategoryScore, CheckResult, CheckStatus, Grade, Grading, RepoSnapshot, TreeEntry } from './types.js';

export const CATEGORY_LABELS: Record<CategoryId, string> = {
	instructions: 'Agent instructions',
	tests: 'Tests',
	types: 'Type & lint checks',
	ci: 'CI',
	setup: 'Setup clarity',
	guardrails: 'Guardrails'
};
export const CATEGORY_ORDER: CategoryId[] = ['instructions', 'tests', 'types', 'ci', 'setup', 'guardrails'];

/** Files whose text the grader wants, in the order GitHub is asked for them. */
export const WANTED_FILES = [
	'CLAUDE.md',
	'AGENTS.md',
	'.github/copilot-instructions.md',
	'.cursorrules',
	'README.md',
	'readme.md',
	'README.rst',
	'README',
	'package.json',
	'pyproject.toml',
	'setup.cfg',
	'tox.ini',
	'pytest.ini',
	'Cargo.toml',
	'go.mod',
	'Makefile',
	'justfile',
	'Justfile',
	'tsconfig.json',
	'jsconfig.json',
	'CONTRIBUTING.md',
	'.github/CONTRIBUTING.md',
	'docs/CONTRIBUTING.md'
] as const;

/** Directories whose immediate entries are listed (for test files and .claude contents). */
export const WANTED_SUBTREES = ['src', 'lib', 'app', 'pkg', 'packages', 'internal', '.claude'] as const;

export const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md', '.cursorrules'];
const README_FILES = ['README.md', 'readme.md', 'README.rst', 'README'];

export type Ecosystem = 'node' | 'python' | 'rust' | 'go';

const COMMAND_RE =
	/\b(npm|pnpm|yarn|bun|npx|deno|pytest|python -m|uv|poetry|tox|nox|hatch|cargo|go (test|build|run|vet)|make|just|tsc|ruff|mypy|pyright|eslint|biome|gradle|mvn|dotnet|bundle exec|rake|mix)\b/;
const TEST_CMD_RE =
	/\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|vitest|jest|mocha|playwright test|pytest|tox|nox|cargo (test|nextest)|go test|make test|just test|deno test|mvn test|gradle test|dotnet test|rspec|mix test)\b/i;
const CHECK_CMD_RE =
	/\b(lint|typecheck|type-check|tsc|svelte-check|vue-tsc|mypy|pyright|ruff|flake8|eslint|biome|clippy|cargo fmt|gofmt|golangci|go vet|prettier --check|check)\b/i;

const MAX_INSTRUCTIONS_BYTES = 40_000;

// --- helpers ---------------------------------------------------------------------------------

function hasRoot(s: RepoSnapshot, ...names: string[]) {
	const set = new Set(s.root.map((e) => e.name.toLowerCase()));
	return names.some((n) => set.has(n.toLowerCase()));
}

function rootMatching(s: RepoSnapshot, re: RegExp) {
	return s.root.filter((e) => re.test(e.name));
}

function file(s: RepoSnapshot, ...paths: string[]): string | null {
	for (const p of paths) if (typeof s.files[p] === 'string') return s.files[p];
	return null;
}

function packageJson(s: RepoSnapshot): {
	scripts?: Record<string, string>;
	engines?: unknown;
	packageManager?: string;
	volta?: unknown;
	devDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
} | null {
	const text = file(s, 'package.json');
	if (!text) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === 'object' ? parsed : null;
	} catch {
		return null;
	}
}

function runScript(s: RepoSnapshot, name: string): string {
	const pm = hasRoot(s, 'pnpm-lock.yaml')
		? 'pnpm'
		: hasRoot(s, 'yarn.lock')
			? 'yarn'
			: hasRoot(s, 'bun.lock', 'bun.lockb')
				? 'bun run'
				: 'npm run';
	if (name === 'test') return pm === 'npm run' ? 'npm test' : `${pm.split(' ')[0]} test`;
	return `${pm} ${name}`;
}

export function detectEcosystems(s: RepoSnapshot): Ecosystem[] {
	const out: Ecosystem[] = [];
	if (hasRoot(s, 'package.json')) out.push('node');
	if (hasRoot(s, 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile')) out.push('python');
	if (hasRoot(s, 'Cargo.toml')) out.push('rust');
	if (hasRoot(s, 'go.mod')) out.push('go');
	return out;
}

function makeTarget(s: RepoSnapshot, target: string): boolean {
	const re = new RegExp(`^${target}[\\w-]*\\s*:`, 'm');
	return [file(s, 'Makefile'), file(s, 'justfile', 'Justfile')].some((t) => !!t && re.test(t));
}

function check(
	id: string,
	category: CategoryId,
	label: string,
	max: number,
	status: CheckStatus,
	detail: string,
	partialPoints = Math.round(max / 2)
): CheckResult {
	const points = status === 'pass' ? max : status === 'partial' ? Math.min(partialPoints, max) : 0;
	return { id, category, label, points, max, status, detail };
}

const isTestName = (n: string) => /(^|[._-])(test|tests|spec)([._-]|$)/i.test(n) || /^test_.*\.py$/.test(n) || /_test\.(go|py|rs)$/.test(n);

function hasTestFiles(s: RepoSnapshot): string | null {
	const dir = s.root.find((e) => e.type === 'tree' && /^(tests?|__tests__|spec|specs|e2e|testing)$/i.test(e.name));
	if (dir) return `${dir.name}/`;
	const rootFile = s.root.find((e) => e.type === 'blob' && isTestName(e.name));
	if (rootFile) return rootFile.name;
	for (const [dirName, entries] of Object.entries(s.subtrees)) {
		if (dirName === '.claude') continue;
		const hit = entries.find((e: TreeEntry) => (e.type === 'tree' ? /^(tests?|__tests__|spec)$/i.test(e.name) : isTestName(e.name)));
		if (hit) return `${dirName}/${hit.name}${hit.type === 'tree' ? '/' : ''}`;
	}
	return null;
}

// --- checks ----------------------------------------------------------------------------------

function instructionChecks(s: RepoSnapshot): CheckResult[] {
	// CLAUDE.md often just imports AGENTS.md (or is a symlink to it), so read them together.
	const present = INSTRUCTION_FILES.filter((p) => typeof s.files[p] === 'string');
	const found = present.join(' + ') || undefined;
	const text = [...new Set(present.map((p) => s.files[p]))].join('\n\n');
	const claudeDir = s.subtrees['.claude'];
	const C = 'instructions' as const;

	if (!found) {
		const none = 'No CLAUDE.md, AGENTS.md or similar agent instructions file.';
		return [
			check('instructions-file', C, 'Agent instructions file', 10, 'fail', none),
			check('instructions-substance', C, 'Instructions have substance', 5, 'fail', 'Nothing to read yet.'),
			check('instructions-commands', C, 'Instructions say how to build and test', 7, 'fail', 'Nothing to read yet.'),
			check('instructions-size', C, 'Instructions are a sensible size', 3, 'fail', 'Nothing to read yet.')
		];
	}

	const extra = claudeDir?.length
		? ` Also has a .claude/ folder (${claudeDir
				.map((e) => e.name)
				.slice(0, 4)
				.join(', ')}).`
		: '';
	const bytes = new TextEncoder().encode(text).length;
	const commandLines = text.split('\n').filter((l) => COMMAND_RE.test(l));
	const mentionsTest = TEST_CMD_RE.test(text) || commandLines.some((l) => /test/i.test(l));

	return [
		check('instructions-file', C, 'Agent instructions file', 10, 'pass', `Found ${present.join(', ')}.${extra}`),
		check(
			'instructions-substance',
			C,
			'Instructions have substance',
			5,
			text.trim().length >= 300 ? 'pass' : 'partial',
			text.trim().length >= 300
				? `${text.trim().length.toLocaleString('en-US')} characters of instructions.`
				: `Only ${text.trim().length} characters of instructions; agents need more to go on.`,
			2
		),
		check(
			'instructions-commands',
			C,
			'Instructions say how to build and test',
			7,
			mentionsTest ? 'pass' : commandLines.length ? 'partial' : 'fail',
			mentionsTest
				? 'Lists the commands to run, including tests.'
				: commandLines.length
					? 'Lists some commands, but not how to run the tests.'
					: 'No build or test commands listed.',
			3
		),
		check(
			'instructions-size',
			C,
			'Instructions are a sensible size',
			3,
			bytes > MAX_INSTRUCTIONS_BYTES ? 'fail' : 'pass',
			bytes > MAX_INSTRUCTIONS_BYTES
				? `${found} is ${Math.round(bytes / 1000)} KB; very long instructions crowd out the task.`
				: 'Short enough to read in full every session.'
		)
	];
}

function testCommand(s: RepoSnapshot, eco: Ecosystem[]): { status: CheckStatus; detail: string } {
	const pkg = packageJson(s);
	const scripts = pkg?.scripts ?? {};
	if (eco.includes('node')) {
		const test = scripts.test;
		if (test && !/no test specified/i.test(test))
			return { status: 'pass', detail: `\`${runScript(s, 'test')}\` runs \`${test.slice(0, 60)}\`.` };
		const other = Object.keys(scripts).find((k) => /^test[:-]/.test(k));
		if (other) return { status: 'pass', detail: `\`${runScript(s, other)}\` runs the tests.` };
	}
	if (eco.includes('rust')) return { status: 'pass', detail: 'cargo test works out of the box.' };
	if (eco.includes('go')) return { status: 'pass', detail: 'go test ./... works out of the box.' };
	if (eco.includes('python')) {
		const py = file(s, 'pyproject.toml') ?? '';
		if (
			hasRoot(s, 'pytest.ini', 'tox.ini', 'noxfile.py', 'conftest.py') ||
			/\[tool\.(pytest|hatch\.envs|tox)/.test(py) ||
			/\[tool:pytest\]/.test(file(s, 'setup.cfg') ?? '')
		)
			return { status: 'pass', detail: 'pytest/tox is configured.' };
		if (/\bpytest\b/.test(py))
			return { status: 'partial', detail: 'pytest is a dependency but not configured; agents have to guess the invocation.' };
	}
	if (makeTarget(s, 'test')) return { status: 'pass', detail: 'make/just has a test target.' };
	if (eco.includes('node') && scripts.test) return { status: 'fail', detail: 'package.json still has the npm placeholder test script.' };
	return { status: 'fail', detail: 'No single command that runs the tests.' };
}

function testChecks(s: RepoSnapshot, eco: Ecosystem[]): CheckResult[] {
	const cmd = testCommand(s, eco);
	const tests = hasTestFiles(s);
	return [
		check('tests-command', 'tests', 'One command runs the tests', 10, cmd.status, cmd.detail, 5),
		check(
			'tests-present',
			'tests',
			'Test files exist',
			10,
			tests ? 'pass' : 'fail',
			tests ? `Found ${tests}.` : 'No test files or test folders near the top of the repo.'
		)
	];
}

function typeChecks(s: RepoSnapshot, eco: Ecosystem[]): CheckResult[] {
	const pkg = packageJson(s);
	const scripts = Object.entries(pkg?.scripts ?? {});
	const py = file(s, 'pyproject.toml') ?? '';
	let types: { status: CheckStatus; detail: string };

	if (eco.includes('rust') || eco.includes('go')) {
		types = { status: 'pass', detail: `${eco.includes('rust') ? 'Rust' : 'Go'} is checked by the compiler.` };
	} else if (eco.includes('node')) {
		const tsconfig = hasRoot(s, 'tsconfig.json');
		const script = scripts.find(
			([k, v]) => /tsc|svelte-check|vue-tsc|astro check/.test(v) || /^(typecheck|type-check|check|types)$/.test(k)
		);
		if (tsconfig && script) types = { status: 'pass', detail: `TypeScript, checked with \`${runScript(s, script[0])}\`.` };
		else if (tsconfig) types = { status: 'partial', detail: 'TypeScript is set up, but no script runs the type checker.' };
		else if (hasRoot(s, 'jsconfig.json') && /checkJs/.test(file(s, 'jsconfig.json') ?? ''))
			types = { status: 'partial', detail: 'JavaScript with checkJs; no dedicated type-check script.' };
		else types = { status: 'fail', detail: 'Plain JavaScript with no type checking.' };
	} else if (eco.includes('python')) {
		if (
			hasRoot(s, 'mypy.ini', '.mypy.ini', 'pyrightconfig.json') ||
			/\[tool\.(mypy|pyright|basedpyright)\]/.test(py) ||
			/\[mypy\]/.test(file(s, 'setup.cfg') ?? '')
		)
			types = { status: 'pass', detail: 'mypy/pyright is configured.' };
		else if (/\b(mypy|pyright)\b/.test(py)) types = { status: 'partial', detail: 'A type checker is a dependency but not configured.' };
		else types = { status: 'fail', detail: 'No mypy or pyright configuration.' };
	} else {
		types = { status: 'fail', detail: 'Could not find a type checker for this project.' };
	}

	const lintConfigs = rootMatching(
		s,
		/^(\.?eslint(rc)?(\.\w+)?|eslint\.config\.\w+|biome\.jsonc?|\.prettierrc(\.\w+)?|prettier\.config\.\w+|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|\.golangci\.ya?ml|rustfmt\.toml|\.rustfmt\.toml|clippy\.toml|\.rubocop\.yml|deno\.jsonc?)$/i
	).map((e) => e.name);
	if (/\[tool\.(ruff|black|pylint|flake8)/.test(py)) lintConfigs.push('pyproject.toml');
	const lintScript = scripts.find(([k]) => /^(lint|format|fmt)/.test(k));
	let lint: { status: CheckStatus; detail: string };
	if (lintConfigs.length) lint = { status: 'pass', detail: `Configured: ${lintConfigs.slice(0, 3).join(', ')}.` };
	else if (lintScript) lint = { status: 'pass', detail: `\`${runScript(s, lintScript[0])}\` lints the code.` };
	else if (eco.includes('rust') || eco.includes('go'))
		lint = { status: 'partial', detail: 'Default rustfmt/gofmt only; no linter configuration.' };
	else lint = { status: 'fail', detail: 'No linter or formatter configuration.' };

	return [
		check('types-checker', 'types', 'Type checking', 8, types.status, types.detail, 4),
		check('types-lint', 'types', 'Linter or formatter', 7, lint.status, lint.detail, 4)
	];
}

function ciChecks(s: RepoSnapshot): CheckResult[] {
	const wf = s.workflows;
	const other = hasRoot(s, '.gitlab-ci.yml', '.circleci', '.travis.yml', 'azure-pipelines.yml', '.buildkite', 'Jenkinsfile');
	const allText = wf.map((w) => w.text).join('\n');
	const runsTests = TEST_CMD_RE.test(allText) || /\b(run|script):.*\btest\b/i.test(allText);
	const runsChecks = CHECK_CMD_RE.test(allText);

	if (!wf.length && !other) {
		return [
			check('ci-exists', 'ci', 'CI is set up', 5, 'fail', 'No GitHub Actions workflows or other CI config.'),
			check('ci-tests', 'ci', 'CI runs the tests', 6, 'fail', 'No CI to run them.'),
			check('ci-checks', 'ci', 'CI runs type or lint checks', 4, 'fail', 'No CI to run them.')
		];
	}
	if (!wf.length) {
		return [
			check('ci-exists', 'ci', 'CI is set up', 5, 'pass', 'CI is configured outside GitHub Actions.'),
			check('ci-tests', 'ci', 'CI runs the tests', 6, 'partial', 'Could not read non-GitHub CI config; assuming partial.', 3),
			check('ci-checks', 'ci', 'CI runs type or lint checks', 4, 'partial', 'Could not read non-GitHub CI config; assuming partial.', 2)
		];
	}
	return [
		check('ci-exists', 'ci', 'CI is set up', 5, 'pass', `${wf.length} GitHub Actions workflow${wf.length === 1 ? '' : 's'}.`),
		check(
			'ci-tests',
			'ci',
			'CI runs the tests',
			6,
			runsTests ? 'pass' : 'fail',
			runsTests ? 'A workflow runs the test suite.' : 'No workflow appears to run the tests.'
		),
		check(
			'ci-checks',
			'ci',
			'CI runs type or lint checks',
			4,
			runsChecks ? 'pass' : 'fail',
			runsChecks ? 'A workflow runs type or lint checks.' : 'No workflow appears to run type or lint checks.'
		)
	];
}

function setupChecks(s: RepoSnapshot, eco: Ecosystem[]): CheckResult[] {
	const readme = file(s, ...README_FILES);
	const instructions = INSTRUCTION_FILES.map((p) => s.files[p]).find((t) => typeof t === 'string') ?? '';
	const docs = `${readme ?? ''}\n${instructions}`;
	const pkg = packageJson(s);
	const C = 'setup' as const;

	const SECTION =
		'(install|installation|getting started|setup|set up|quick ?start|development|developing|build|building|usage|running|local)';
	const hasSection =
		new RegExp(`^#{1,4}\\s.*\\b${SECTION}\\b`, 'im').test(readme ?? '') ||
		new RegExp(`^.*\\b${SECTION}\\b.*\\n[=\\-~]{3,}\\s*$`, 'im').test(readme ?? '');
	const readmeCheck = !readme
		? check('setup-readme', C, 'README explains setup', 5, 'fail', 'No README.')
		: hasSection && COMMAND_RE.test(readme)
			? check('setup-readme', C, 'README explains setup', 5, 'pass', 'README has setup steps with commands.')
			: check(
					'setup-readme',
					C,
					'README explains setup',
					5,
					'partial',
					'README exists but has no clear install/run section with commands.',
					2
				);

	const lockfiles = rootMatching(
		s,
		/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|deno\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/
	).map((e) => e.name);
	let lock: CheckResult;
	if (lockfiles.length) lock = check('setup-lockfile', C, 'Dependencies are locked', 4, 'pass', `Found ${lockfiles.join(', ')}.`);
	else if (eco.includes('python') && hasRoot(s, 'requirements.txt'))
		lock = check('setup-lockfile', C, 'Dependencies are locked', 4, 'partial', 'requirements.txt but no lockfile.', 2);
	else if (eco.includes('rust'))
		lock = check(
			'setup-lockfile',
			C,
			'Dependencies are locked',
			4,
			'partial',
			'No Cargo.lock (common for libraries, but agents get less reproducible builds).',
			2
		);
	else if (!eco.length) lock = check('setup-lockfile', C, 'Dependencies are locked', 4, 'partial', 'No recognized package manager.', 2);
	else lock = check('setup-lockfile', C, 'Dependencies are locked', 4, 'fail', 'No lockfile committed.');

	const pyproject = file(s, 'pyproject.toml') ?? '';
	const pinned =
		hasRoot(
			s,
			'.nvmrc',
			'.node-version',
			'.tool-versions',
			'mise.toml',
			'.mise.toml',
			'.python-version',
			'rust-toolchain',
			'rust-toolchain.toml',
			'.ruby-version',
			'flake.nix',
			'.devcontainer',
			'devbox.json'
		) ||
		!!pkg?.engines ||
		!!pkg?.volta ||
		!!pkg?.packageManager ||
		/requires-python/.test(pyproject) ||
		/^go \d/m.test(file(s, 'go.mod') ?? '') ||
		/rust-version/.test(file(s, 'Cargo.toml') ?? '');
	const runtime = check(
		'setup-runtime',
		C,
		'Runtime version is pinned',
		3,
		pinned ? 'pass' : 'fail',
		pinned
			? 'The expected language/tool version is declared.'
			: 'No .nvmrc, .tool-versions, engines or similar; agents guess the runtime version.'
	);

	const envExample = rootMatching(s, /^\.env\.(example|sample|template|dist|defaults)$|^example\.env$/i).map((e) => e.name);
	const mentionsEnv = /\b(environment variables?|env vars?|\.env\b|process\.env|os\.environ|API_KEY|_TOKEN\b)/.test(docs);
	const env = envExample.length
		? check('setup-env', C, 'Environment variables are documented', 3, 'pass', `Found ${envExample[0]}.`)
		: mentionsEnv
			? check(
					'setup-env',
					C,
					'Environment variables are documented',
					3,
					'partial',
					'Docs mention environment variables but there is no .env.example.',
					1
				)
			: check('setup-env', C, 'Environment variables are documented', 3, 'pass', 'No environment variables appear to be required.');

	return [readmeCheck, lock, runtime, env];
}

function guardrailChecks(s: RepoSnapshot): CheckResult[] {
	const contributing =
		!!file(s, 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'docs/CONTRIBUTING.md') ||
		hasRoot(s, 'CONTRIBUTING.md', 'CONTRIBUTING.rst', 'CONTRIBUTING');
	const hooks = hasRoot(s, '.pre-commit-config.yaml', '.husky', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.githooks');
	const junk = s.root
		.filter((e) => /^(node_modules|\.env|\.venv|venv|__pycache__|\.DS_Store|target|\.next|\.svelte-kit)$/.test(e.name))
		.map((e) => e.name);
	return [
		check(
			'guardrails-contributing',
			'guardrails',
			'Contribution guide',
			3,
			contributing ? 'pass' : 'fail',
			contributing ? 'Has a CONTRIBUTING guide.' : 'No CONTRIBUTING guide.'
		),
		check(
			'guardrails-hooks',
			'guardrails',
			'Pre-commit hooks',
			3,
			hooks ? 'pass' : 'fail',
			hooks ? 'Pre-commit hooks catch mistakes before they land.' : 'No pre-commit hooks (pre-commit, husky, lefthook).'
		),
		check(
			'guardrails-clean',
			'guardrails',
			'No committed junk',
			4,
			junk.length ? 'fail' : 'pass',
			junk.length
				? `Committed: ${junk.join(', ')}. Agents waste time (and context) reading these.`
				: 'No build output, dependencies or secrets committed at the root.'
		)
	];
}

// --- scoring ---------------------------------------------------------------------------------

export function runChecks(s: RepoSnapshot): CheckResult[] {
	const eco = detectEcosystems(s);
	return [
		...instructionChecks(s),
		...testChecks(s, eco),
		...typeChecks(s, eco),
		...ciChecks(s),
		...setupChecks(s, eco),
		...guardrailChecks(s)
	];
}

export function categoryScores(checks: CheckResult[]): CategoryScore[] {
	return CATEGORY_ORDER.map((id) => {
		const cs = checks.filter((c) => c.category === id);
		return {
			id,
			label: CATEGORY_LABELS[id],
			points: cs.reduce((n, c) => n + c.points, 0),
			max: cs.reduce((n, c) => n + c.max, 0)
		};
	});
}

const GRADE_FLOORS: [number, Grade][] = [
	[95, 'A+'],
	[90, 'A'],
	[85, 'A-'],
	[80, 'B+'],
	[75, 'B'],
	[70, 'B-'],
	[65, 'C+'],
	[60, 'C'],
	[55, 'C-'],
	[45, 'D']
];

export function gradeFor(score: number): Grade {
	return GRADE_FLOORS.find(([floor]) => score >= floor)?.[1] ?? 'F';
}

export function scoreReport(checks: CheckResult[]): { score: number; grade: Grade; categories: CategoryScore[] } {
	const max = checks.reduce((n, c) => n + c.max, 0);
	const points = checks.reduce((n, c) => n + c.points, 0);
	const score = max ? Math.round((points / max) * 100) : 0;
	return { score, grade: gradeFor(score), categories: categoryScores(checks) };
}

/** Run every check and score the result. */
export function gradeSnapshot(s: RepoSnapshot): Grading {
	const checks = runChecks(s);
	return { ecosystems: detectEcosystems(s), ...scoreReport(checks), checks };
}

const GRADE_ORDER: Grade[] = ['F', 'D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+'];

export const isGrade = (g: string): g is Grade => (GRADE_ORDER as string[]).includes(g);

/** True when `grade` is at least `min` (so `meetsGrade('B+', 'B')` is true). */
export function meetsGrade(grade: Grade, min: Grade): boolean {
	return GRADE_ORDER.indexOf(grade) >= GRADE_ORDER.indexOf(min);
}

// --- detected commands -----------------------------------------------------------------------

export interface DetectedCommands {
	install?: string;
	run?: string;
	test?: string;
	typecheck?: string;
	lint?: string;
}

/**
 * The commands an agent would run, read only from files in the snapshot. Anything not found is
 * left out, so callers can write a TODO rather than guess.
 */
export function detectCommands(s: RepoSnapshot): DetectedCommands {
	const eco = detectEcosystems(s);
	const out: DetectedCommands = {};
	const scripts = packageJson(s)?.scripts ?? {};
	const pick = (re: RegExp) => Object.keys(scripts).find((k) => re.test(k));

	if (eco.includes('node')) {
		out.install = hasRoot(s, 'pnpm-lock.yaml')
			? 'pnpm install'
			: hasRoot(s, 'yarn.lock')
				? 'yarn install'
				: hasRoot(s, 'bun.lock', 'bun.lockb')
					? 'bun install'
					: hasRoot(s, 'package-lock.json')
						? 'npm ci'
						: 'npm install';
		const dev = pick(/^(dev|start|serve)$/);
		if (dev) out.run = runScript(s, dev);
		const test = scripts.test && !/no test specified/i.test(scripts.test) ? 'test' : pick(/^test[:-]/);
		if (test) out.test = runScript(s, test);
		// A script named for type checking wins over one that merely runs tsc (such as build).
		const typecheck =
			pick(/^(typecheck|type-check|check|types|check-types)$/) ??
			Object.entries(scripts).find(([k, v]) => /\b(tsc|svelte-check|vue-tsc)\b/.test(v) && !/^(build|prepare|prepack)/.test(k))?.[0];
		if (typecheck) out.typecheck = runScript(s, typecheck);
		const lint = pick(/^lint$/) ?? pick(/^(lint|format|fmt)/);
		if (lint) out.lint = runScript(s, lint);
	}
	if (eco.includes('rust')) {
		out.install ??= 'cargo build';
		out.test ??= 'cargo test';
		out.typecheck ??= 'cargo check';
		out.lint ??= 'cargo clippy';
	}
	if (eco.includes('go')) {
		out.install ??= 'go mod download';
		out.test ??= 'go test ./...';
		out.typecheck ??= 'go vet ./...';
	}
	if (eco.includes('python')) {
		const py = file(s, 'pyproject.toml') ?? '';
		if (!out.install) {
			if (hasRoot(s, 'uv.lock')) out.install = 'uv sync';
			else if (hasRoot(s, 'poetry.lock')) out.install = 'poetry install';
			else if (hasRoot(s, 'requirements.txt')) out.install = 'pip install -r requirements.txt';
			else if (py) out.install = 'pip install -e .';
		}
		if (!out.test && (hasRoot(s, 'pytest.ini', 'conftest.py') || /\[tool\.pytest/.test(py))) out.test = 'pytest';
		else if (!out.test && hasRoot(s, 'tox.ini')) out.test = 'tox';
		if (!out.typecheck && (hasRoot(s, 'mypy.ini') || /\[tool\.mypy\]/.test(py))) out.typecheck = 'mypy .';
		else if (!out.typecheck && (hasRoot(s, 'pyrightconfig.json') || /\[tool\.pyright\]/.test(py))) out.typecheck = 'pyright';
		if (!out.lint && (hasRoot(s, 'ruff.toml', '.ruff.toml') || /\[tool\.ruff/.test(py))) out.lint = 'ruff check .';
	}
	for (const key of ['test', 'lint'] as const) {
		if (!out[key] && makeTarget(s, key)) out[key] = `${file(s, 'Makefile') ? 'make' : 'just'} ${key}`;
	}
	return out;
}
