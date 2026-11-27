// Build a snapshot from GitHub's GraphQL API in one request. This module only builds the query
// and reads the result; send it with whatever HTTP client and token you already have.
import { INSTRUCTION_FILES, WANTED_FILES, WANTED_SUBTREES } from './checks.js';
import type { RepoSnapshot, TreeEntry } from './types.js';

export const MAX_FILE_CHARS = 20_000;
/** Instruction files keep more text so the "too long" check can see their real size. */
export const MAX_INSTRUCTION_CHARS = 60_000;
export const MAX_WORKFLOWS = 12;

type RawEntry = {
	name: string;
	type: string;
	object?: { text?: string | null; isBinary?: boolean | null; entries?: RawEntry[] } | null;
};
type RawTree = { entries?: RawEntry[] } | null;
type RawBlob = { text?: string | null; isBinary?: boolean | null } | null;

/** The `repository` field of a response to `GITHUB_SNAPSHOT_QUERY`. */
export type GithubRepository =
	| ({
			name: string;
			owner: { login: string };
			description: string | null;
			stargazerCount: number;
			isArchived: boolean;
			isPrivate: boolean;
			isEmpty: boolean;
			pushedAt: string | null;
			defaultBranchRef: { name: string } | null;
			root: RawTree;
			workflows: RawTree;
	  } & Record<string, unknown>)
	| null;

export interface GithubSnapshotResult {
	repository: GithubRepository;
}

/** Why a GitHub response could not become a snapshot. */
export class SnapshotError extends Error {
	constructor(
		public reason: 'not-found' | 'private' | 'empty',
		message: string
	) {
		super(message);
		this.name = 'SnapshotError';
	}
}

const OWNER_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
const REPO_RE = /^[\w.-]{1,100}$/;

/** True for names GitHub would accept as an owner and repository. */
export const isValidRepoName = (owner: string, repo: string) => OWNER_RE.test(owner) && REPO_RE.test(repo) && repo !== '.' && repo !== '..';

/** Parse "owner/repo", "github.com/owner/repo", an SSH remote, or a full GitHub URL (with .git or extra path). */
export function parseRepoInput(input: string): { owner: string; repo: string } | null {
	const m = input
		.trim()
		.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
		.replace(/^git@github\.com:/i, '')
		.match(/^([^/\s]+)\/([^/\s#?]+)/);
	if (!m) return null;
	const owner = m[1];
	const repo = m[2].replace(/\.git$/i, '');
	return isValidRepoName(owner, repo) ? { owner, repo } : null;
}

const fileAlias = (i: number) => `f${i}`;
const treeAlias = (i: number) => `t${i}`;

function buildQuery(): string {
	const files = WANTED_FILES.map(
		(p, i) => `${fileAlias(i)}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Blob { text isBinary } }`
	);
	// Two levels deep, so monorepo packages (packages/foo/test) are visible too.
	const trees = WANTED_SUBTREES.map(
		(p, i) =>
			`${treeAlias(i)}: object(expression: ${JSON.stringify(`HEAD:${p}`)}) { ... on Tree { entries { name type object { ... on Tree { entries { name type } } } } } }`
	);
	return `query ($owner: String!, $name: String!) {
		repository(owner: $owner, name: $name) {
			name
			owner { login }
			description
			stargazerCount
			isArchived
			isPrivate
			isEmpty
			pushedAt
			defaultBranchRef { name }
			root: object(expression: "HEAD:") { ... on Tree { entries { name type } } }
			workflows: object(expression: "HEAD:.github/workflows") {
				... on Tree { entries { name type object { ... on Blob { text isBinary } } } }
			}
			${files.join('\n\t\t\t')}
			${trees.join('\n\t\t\t')}
		}
	}`;
}

/** GraphQL query with `$owner` and `$name` variables. Send it to https://api.github.com/graphql. */
export const GITHUB_SNAPSHOT_QUERY = buildQuery();

const toEntries = (t: RawTree): TreeEntry[] =>
	(t?.entries ?? []).filter((e) => e.type === 'blob' || e.type === 'tree').map((e) => ({ name: e.name, type: e.type as 'blob' | 'tree' }));

/**
 * When a file's whole text is another wanted file's path, it is a symlink GitHub returned as
 * its target (CLAUDE.md -> AGENTS.md); read the target's text instead.
 */
export function resolveInstructionSymlinks(files: Record<string, string>): void {
	for (const path of INSTRUCTION_FILES) {
		const target = files[path]?.trim();
		if (target && /^[\w./-]+$/.test(target) && target !== path && typeof files[target] === 'string') {
			files[path] = files[target];
		}
	}
}

/**
 * Fetch and build a snapshot with `fetch`. GitHub's GraphQL API needs a token, even for public
 * repositories; any token with read access to the repository works.
 */
export async function fetchGithubSnapshot(
	owner: string,
	name: string,
	opts: { token: string; fetch?: typeof fetch; userAgent?: string; allowPrivate?: boolean }
): Promise<RepoSnapshot> {
	const res = await (opts.fetch ?? fetch)('https://api.github.com/graphql', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${opts.token}`,
			'content-type': 'application/json',
			'user-agent': opts.userAgent ?? 'agent-ready'
		},
		body: JSON.stringify({ query: GITHUB_SNAPSHOT_QUERY, variables: { owner, name } })
	});
	if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
	const body = (await res.json()) as { data?: GithubSnapshotResult; errors?: { type?: string; message: string }[] };
	if (body.errors?.some((e) => e.type === 'NOT_FOUND')) throw new SnapshotError('not-found', `No repository at ${owner}/${name}.`);
	if (!body.data) throw new Error(body.errors?.[0]?.message ?? 'GitHub API error');
	return snapshotFromGithub(body.data, { allowPrivate: opts.allowPrivate });
}

/**
 * Turn a `GITHUB_SNAPSHOT_QUERY` response into a snapshot. Throws `SnapshotError` for missing,
 * private or empty repositories (pass `{ allowPrivate: true }` to grade private ones).
 */
export function snapshotFromGithub(data: GithubSnapshotResult, opts: { allowPrivate?: boolean } = {}): RepoSnapshot {
	const r = data.repository;
	if (!r) throw new SnapshotError('not-found', 'No repository found.');
	if (r.isPrivate && !opts.allowPrivate) throw new SnapshotError('private', `${r.owner.login}/${r.name} is private.`);
	if (r.isEmpty || !r.root) throw new SnapshotError('empty', `${r.owner.login}/${r.name} is empty, so there is nothing to grade yet.`);

	const files: Record<string, string> = {};
	WANTED_FILES.forEach((path, i) => {
		const blob = r[fileAlias(i)] as RawBlob;
		if (!blob || blob.isBinary || typeof blob.text !== 'string') return;
		const max = INSTRUCTION_FILES.includes(path) ? MAX_INSTRUCTION_CHARS : MAX_FILE_CHARS;
		files[path] = blob.text.slice(0, max);
	});
	resolveInstructionSymlinks(files);

	const subtrees: Record<string, TreeEntry[]> = {};
	WANTED_SUBTREES.forEach((path, i) => {
		const t = r[treeAlias(i)] as RawTree;
		if (!t?.entries) return;
		subtrees[path] = toEntries(t);
		for (const e of t.entries) {
			if (e.type === 'tree' && e.object?.entries) subtrees[`${path}/${e.name}`] = toEntries(e.object);
		}
	});

	const workflows = (r.workflows?.entries ?? [])
		.filter((e) => e.type === 'blob' && /\.ya?ml$/i.test(e.name) && typeof e.object?.text === 'string')
		.slice(0, MAX_WORKFLOWS)
		.map((e) => ({ name: e.name, text: (e.object?.text ?? '').slice(0, MAX_FILE_CHARS) }));

	return {
		owner: r.owner.login,
		name: r.name,
		description: r.description,
		stars: r.stargazerCount,
		isArchived: r.isArchived,
		defaultBranch: r.defaultBranchRef?.name ?? 'main',
		pushedAt: r.pushedAt,
		root: toEntries(r.root),
		subtrees,
		workflows,
		files
	};
}
