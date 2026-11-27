import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { meetsGrade } from '../src/checks.js';
import { main } from '../src/cli.js';

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'agent-ready-cli-'));
	writeFileSync(join(dir, 'README.md'), '# demo\n');
	writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(...args: string[]) {
	let out = '';
	let err = '';
	const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
		out += String(s);
		return true;
	});
	const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
		err += String(s);
		return true;
	});
	try {
		return { code: await main(args), out, err };
	} finally {
		o.mockRestore();
		e.mockRestore();
	}
}

describe('cli', () => {
	it('prints a readable report', async () => {
		const r = await run(dir, '--no-color');
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/agent-ready-cli-\w+ {2}[A-F][+-]? \(\d+\/100\)/);
		expect(r.out).toContain('Suggested fixes');
		expect(r.out).toContain('npm test');
	});

	it('prints JSON with checks and a review', async () => {
		const r = await run(dir, '--json');
		const report = JSON.parse(r.out);
		expect(report.checks).toHaveLength(18);
		expect(report.review.fixes[0].title).toBe('Add a CLAUDE.md');
	});

	it('prints a review prompt with the data wrapped', async () => {
		const r = await run(dir, '--prompt');
		expect(r.out).toContain('agent readiness');
		expect(r.out).toContain('<data>');
	});

	it('prints a starter CLAUDE.md', async () => {
		expect((await run(dir, '--claude-md')).out).toContain('- Test: `npm test`');
	});

	it('exits 1 below --min-grade and 0 at or above it', async () => {
		expect((await run(dir, '--json', '--min-grade', 'A+')).code).toBe(1);
		expect((await run(dir, '--json', '--min-grade', 'F')).code).toBe(0);
	});

	it('exits 2 on bad usage', async () => {
		expect((await run(dir, '--min-grade', 'Z')).code).toBe(2);
		expect((await run(dir, '--json', '--prompt')).code).toBe(2);
		expect((await run('--nope')).code).toBe(2);
	});

	it('needs a token for GitHub targets', async () => {
		const saved = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN];
		delete process.env.GITHUB_TOKEN;
		delete process.env.GH_TOKEN;
		try {
			const r = await run('octo/definitely-not-a-local-path');
			expect(r.code).toBe(2);
			expect(r.err).toContain('GITHUB_TOKEN');
		} finally {
			[process.env.GITHUB_TOKEN, process.env.GH_TOKEN] = saved;
			if (saved[0] === undefined) delete process.env.GITHUB_TOKEN;
			if (saved[1] === undefined) delete process.env.GH_TOKEN;
		}
	});
});

describe('meetsGrade', () => {
	it('orders grades', () => {
		expect(meetsGrade('B+', 'B')).toBe(true);
		expect(meetsGrade('B-', 'B')).toBe(false);
		expect(meetsGrade('A+', 'A+')).toBe(true);
	});
});
