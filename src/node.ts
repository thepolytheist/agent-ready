// Build a snapshot from a local checkout. Node only; import from "agent-ready/node".
//
// Inside a git repository only files git would commit count (tracked files plus untracked ones
// that are not ignored), so node_modules/ or a local .env on disk does not fail the "committed
// junk" check. Outside git every file on disk counts.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { INSTRUCTION_FILES, WANTED_FILES, WANTED_SUBTREES } from './checks.js';
import { MAX_FILE_CHARS, MAX_INSTRUCTION_CHARS, MAX_WORKFLOWS, resolveInstructionSymlinks } from './github.js';
import type { RepoSnapshot, TreeEntry } from './types.js';

export interface LocalSnapshot extends RepoSnapshot {
	/** Absolute path of the directory that was graded (the git top level when inside git). */
	path: string;
	/** Whether file listings came from git (true) or straight from disk (false). */
	usedGit: boolean;
}

function git(cwd: string, ...args: string[]): string | null {
	try {
		return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
	} catch {
		return null;
	}
}

/** Lists the entries directly inside a repo-relative directory ("" is the root). */
type Lister = (dir: string) => TreeEntry[];

function gitLister(top: string): Lister | null {
	const out = git(top, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
	if (out === null) return null;
	// A tracked file deleted from the working tree is about to be gone; skip it.
	const paths = out.split('\0').filter((p) => p && existsSync(join(top, p)));
	const children = new Map<string, Map<string, TreeEntry['type']>>();
	for (const p of paths) {
		const parts = p.split('/');
		for (let i = 0; i < parts.length; i++) {
			const dir = parts.slice(0, i).join('/');
			const kids = children.get(dir) ?? new Map();
			const type = i === parts.length - 1 ? 'blob' : 'tree';
			if (kids.get(parts[i]) !== 'tree') kids.set(parts[i], type);
			children.set(dir, kids);
		}
	}
	return (dir) => [...(children.get(dir) ?? [])].map(([name, type]) => ({ name, type }));
}

function diskLister(top: string): Lister {
	return (dir) => {
		try {
			return readdirSync(join(top, dir), { withFileTypes: true })
				.filter((d) => d.name !== '.git')
				.map((d) => {
					const isDir =
						d.isDirectory() || (d.isSymbolicLink() && statSync(join(top, dir, d.name), { throwIfNoEntry: false })?.isDirectory());
					return { name: d.name, type: isDir ? ('tree' as const) : ('blob' as const) };
				});
		} catch {
			return [];
		}
	};
}

function readText(path: string, max: number): string | null {
	try {
		const buf = readFileSync(path);
		if (buf.subarray(0, 8000).includes(0)) return null; // binary
		return buf.toString('utf8').slice(0, max);
	} catch {
		return null;
	}
}

function parseRemote(url: string | null): { owner: string; name: string } | null {
	const m = url?.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
	return m ? { owner: m[1], name: m[2] } : null;
}

/** Read the snapshot for the repository containing `dir` (default: the current directory). */
export function readLocalSnapshot(dir = '.'): LocalSnapshot {
	const start = resolve(dir);
	if (!existsSync(start) || !statSync(start).isDirectory()) throw new Error(`${start} is not a directory.`);
	const top = git(start, 'rev-parse', '--show-toplevel')?.trim() || start;
	const fromGit = gitLister(top);
	const list = fromGit ?? diskLister(top);

	const root = list('');
	const has = (dirPath: string, name: string) => list(dirPath).some((e) => e.name === name);
	const exists = (p: string) => {
		const i = p.lastIndexOf('/');
		return has(i < 0 ? '' : p.slice(0, i), i < 0 ? p : p.slice(i + 1));
	};

	const files: Record<string, string> = {};
	for (const p of WANTED_FILES) {
		if (!exists(p)) continue;
		const text = readText(join(top, p), INSTRUCTION_FILES.includes(p) ? MAX_INSTRUCTION_CHARS : MAX_FILE_CHARS);
		if (text !== null) files[p] = text;
	}
	resolveInstructionSymlinks(files);

	const subtrees: Record<string, TreeEntry[]> = {};
	for (const p of WANTED_SUBTREES) {
		if (!root.some((e) => e.name === p && e.type === 'tree')) continue;
		const entries = list(p);
		subtrees[p] = entries;
		for (const e of entries) if (e.type === 'tree') subtrees[`${p}/${e.name}`] = list(`${p}/${e.name}`);
	}

	const workflows = list('.github/workflows')
		.filter((e) => e.type === 'blob' && /\.ya?ml$/i.test(e.name))
		.sort((a, b) => a.name.localeCompare(b.name))
		.slice(0, MAX_WORKFLOWS)
		.flatMap((e) => {
			const text = readText(join(top, '.github/workflows', e.name), MAX_FILE_CHARS);
			return text === null ? [] : [{ name: e.name, text }];
		});

	const remote = parseRemote(git(top, 'remote', 'get-url', 'origin'));
	let description: string | null = null;
	try {
		const d = JSON.parse(files['package.json'] ?? '{}').description;
		if (typeof d === 'string' && d.trim()) description = d.trim();
	} catch {
		// unparseable package.json; the checks report on it
	}

	return {
		owner: remote?.owner ?? 'local',
		name: remote?.name ?? basename(top),
		description,
		stars: 0,
		isArchived: false,
		defaultBranch: git(top, 'rev-parse', '--abbrev-ref', 'HEAD')?.trim() || 'main',
		pushedAt: null,
		root,
		subtrees,
		workflows,
		files,
		path: top,
		usedGit: !!fromGit
	};
}
