import { describe, expect, it, vi } from 'vitest';
import { WANTED_FILES } from '../src/checks.js';
import { fetchGithubSnapshot, GITHUB_SNAPSHOT_QUERY, type GithubRepository, SnapshotError, snapshotFromGithub } from '../src/github.js';

function repository(overrides: Record<string, unknown> = {}): GithubRepository {
	return {
		name: 'kit',
		owner: { login: 'octo' },
		description: 'A kit',
		stargazerCount: 5,
		isArchived: false,
		isPrivate: false,
		isEmpty: false,
		pushedAt: null,
		defaultBranchRef: { name: 'main' },
		root: {
			entries: [
				{ name: 'CLAUDE.md', type: 'blob' },
				{ name: 'src', type: 'tree' },
				{ name: 'sub', type: 'commit' }
			]
		},
		workflows: { entries: [{ name: 'ci.yml', type: 'blob', object: { text: 'run: npm test' } }] },
		...overrides
	};
}

const alias = (path: string) => `f${WANTED_FILES.indexOf(path as (typeof WANTED_FILES)[number])}`;

describe('snapshotFromGithub', () => {
	it('maps files, trees and workflows', () => {
		const s = snapshotFromGithub({
			repository: repository({
				[alias('CLAUDE.md')]: { text: 'AGENTS.md', isBinary: false },
				[alias('AGENTS.md')]: { text: 'Real instructions', isBinary: false },
				t0: { entries: [{ name: 'lib', type: 'tree', object: { entries: [{ name: 'a.test.ts', type: 'blob' }] } }] }
			})
		});
		expect(s.root.map((e) => e.name)).toEqual(['CLAUDE.md', 'src']);
		expect(s.files['CLAUDE.md']).toBe('Real instructions');
		expect(s.subtrees['src/lib']).toEqual([{ name: 'a.test.ts', type: 'blob' }]);
		expect(s.workflows).toEqual([{ name: 'ci.yml', text: 'run: npm test' }]);
	});

	it('refuses missing, private and empty repositories', () => {
		const reason = (data: GithubRepository, allowPrivate = false) => {
			try {
				snapshotFromGithub({ repository: data }, { allowPrivate });
			} catch (e) {
				return (e as SnapshotError).reason;
			}
		};
		expect(reason(null)).toBe('not-found');
		expect(reason(repository({ isPrivate: true }))).toBe('private');
		expect(reason(repository({ isPrivate: true }), true)).toBeUndefined();
		expect(reason(repository({ isEmpty: true }))).toBe('empty');
	});

	it('asks for every wanted file in one query', () => {
		for (const p of WANTED_FILES) expect(GITHUB_SNAPSHOT_QUERY).toContain(JSON.stringify(`HEAD:${p}`));
	});
});

describe('fetchGithubSnapshot', () => {
	it('posts the query with the token and parses the result', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { repository: repository() } })));
		const s = await fetchGithubSnapshot('octo', 'kit', { token: 't0ken', fetch });
		expect(s.name).toBe('kit');
		const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer t0ken');
		expect(JSON.parse(init.body as string).variables).toEqual({ owner: 'octo', name: 'kit' });
	});

	it('turns a NOT_FOUND error into a SnapshotError', async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ errors: [{ type: 'NOT_FOUND', message: 'nope' }] })));
		await expect(fetchGithubSnapshot('octo', 'gone', { token: 't', fetch })).rejects.toBeInstanceOf(SnapshotError);
	});
});
