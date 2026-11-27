// Shared types for the grader. Nothing here touches Node or the network, so it runs anywhere.

export interface TreeEntry {
	name: string;
	type: 'blob' | 'tree';
}

/** Everything the grader reads from a repository. Build one with `snapshotFromGithub` or `readLocalSnapshot`. */
export interface RepoSnapshot {
	owner: string;
	name: string;
	description: string | null;
	stars: number;
	isArchived: boolean;
	defaultBranch: string;
	pushedAt: string | null;
	/** Entries at the repository root. */
	root: TreeEntry[];
	/** Entries one and two levels into common source directories (see `WANTED_SUBTREES`), keyed by path. */
	subtrees: Record<string, TreeEntry[]>;
	/** GitHub Actions workflow files with their (truncated) text. */
	workflows: { name: string; text: string }[];
	/** Text of selected files that exist (see `WANTED_FILES`), keyed by path (truncated). */
	files: Record<string, string>;
}

export type CategoryId = 'instructions' | 'tests' | 'types' | 'ci' | 'setup' | 'guardrails';
export type CheckStatus = 'pass' | 'partial' | 'fail';

export interface CheckResult {
	id: string;
	category: CategoryId;
	label: string;
	points: number;
	max: number;
	status: CheckStatus;
	detail: string;
}

export interface CategoryScore {
	id: CategoryId;
	label: string;
	points: number;
	max: number;
}

export type Grade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'C-' | 'D' | 'F';

export interface Fix {
	title: string;
	why: string;
	/** Optional copyable text: a config block, a command, or a drafted CLAUDE.md. */
	snippet?: string;
	/** For template fixes, the file the snippet is meant to be saved as. */
	path?: string;
}

export interface ReadyReview {
	summary: string;
	setupNotes: string;
	fixes: Fix[];
}

/** The deterministic part of a report: everything except the written review. */
export interface Grading {
	ecosystems: string[];
	score: number;
	grade: Grade;
	categories: CategoryScore[];
	checks: CheckResult[];
}
