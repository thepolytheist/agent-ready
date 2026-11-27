import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks } from '../src/checks.js';
import { readLocalSnapshot } from '../src/node.js';

const dirs: string[] = [];
function repo(files: Record<string, string>, opts: { git?: boolean } = {}): string {
	const dir = mkdtempSync(join(tmpdir(), 'agent-ready-'));
	dirs.push(dir);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(dir, path, '..'), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	if (opts.git !== false) execFileSync('git', ['init', '-q'], { cwd: dir });
	return dir;
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readLocalSnapshot', () => {
	it('ignores gitignored files so local dependencies are not "committed junk"', () => {
		const dir = repo({ '.gitignore': 'node_modules/\n.env\n', 'node_modules/x/index.js': '', '.env': 'SECRET=1', 'README.md': '# hi' });
		const s = readLocalSnapshot(dir);
		expect(s.usedGit).toBe(true);
		expect(s.root.map((e) => e.name).sort()).toEqual(['.gitignore', 'README.md']);
		expect(runChecks(s).find((c) => c.id === 'guardrails-clean')?.status).toBe('pass');
	});

	it('counts everything on disk outside git', () => {
		const dir = repo({ 'node_modules/x/index.js': '' }, { git: false });
		const s = readLocalSnapshot(dir);
		expect(s.usedGit).toBe(false);
		expect(runChecks(s).find((c) => c.id === 'guardrails-clean')?.status).toBe('fail');
	});

	it('reads wanted files, subtrees two levels deep and workflows', () => {
		const dir = repo({
			'package.json': JSON.stringify({ description: 'A thing', scripts: { test: 'vitest' } }),
			'packages/kit/test/a.test.ts': '',
			'src/index.ts': '',
			'.github/workflows/ci.yml': 'steps:\n  - run: npm test',
			'.github/workflows/notes.txt': 'not a workflow'
		});
		const s = readLocalSnapshot(dir);
		expect(s.description).toBe('A thing');
		expect(s.files['package.json']).toContain('vitest');
		expect(s.subtrees['packages/kit']).toEqual(expect.arrayContaining([{ name: 'test', type: 'tree' }]));
		expect(s.subtrees.src).toEqual([{ name: 'index.ts', type: 'blob' }]);
		expect(s.workflows.map((w) => w.name)).toEqual(['ci.yml']);
	});

	it('follows a CLAUDE.md symlink to AGENTS.md', () => {
		const dir = repo({ 'AGENTS.md': 'Run `npm test` before you finish.' });
		symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
		expect(readLocalSnapshot(dir).files['CLAUDE.md']).toContain('npm test');
	});

	it('grades from the git top level when given a subdirectory', () => {
		const dir = repo({ 'README.md': '# hi', 'src/deep/file.ts': '' });
		expect(readLocalSnapshot(join(dir, 'src/deep')).root.map((e) => e.name)).toContain('README.md');
	});

	it('takes owner and name from a GitHub remote', () => {
		const dir = repo({ 'README.md': '# hi' });
		execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/thing.git'], { cwd: dir });
		const s = readLocalSnapshot(dir);
		expect([s.owner, s.name]).toEqual(['octo', 'thing']);
	});
});
