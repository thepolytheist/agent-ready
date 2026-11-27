// agent-ready: grade how ready a repository is for AI coding agents.
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CATEGORY_ORDER, gradeSnapshot, isGrade, meetsGrade } from './checks.js';
import { fetchGithubSnapshot, parseRepoInput, SnapshotError } from './github.js';
import { readLocalSnapshot } from './node.js';
import { buildReviewPrompt, REVIEW_SYSTEM_PROMPT, starterClaudeMd, templateReview } from './review.js';
import type { Grade, RepoSnapshot } from './types.js';

const HELP = `Usage: agent-ready [target] [options]

Grade how ready a repository is for AI coding agents. The score is
deterministic: the same files always get the same grade.

Target:
  a path               a local checkout (default: the current directory)
  owner/repo           a GitHub repository; needs GITHUB_TOKEN in the environment

Options:
  --json               print the full report as JSON
  --prompt             print a review prompt to pipe into your own agent,
                       for example: agent-ready --prompt | claude -p
  --claude-md          print a starter CLAUDE.md filled in from the repo
  --min-grade <grade>  exit 1 if the grade is below this (for CI), e.g. B
  --no-color           disable colored output (NO_COLOR is also respected)
  -h, --help           show this help
  -v, --version        show the version

Exit codes: 0 success, 1 below --min-grade, 2 usage or lookup error.`;

class UsageError extends Error {}

function version(): string {
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
	return pkg.version;
}

async function loadSnapshot(target: string): Promise<{ snapshot: RepoSnapshot; note?: string }> {
	const remote = parseRepoInput(target);
	if (existsSync(target) || !remote) {
		const snapshot = readLocalSnapshot(target);
		return {
			snapshot,
			note: snapshot.usedGit ? undefined : 'Not a git repository; grading every file on disk, including ignored ones.'
		};
	}
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (!token)
		throw new UsageError(`Grading ${remote.owner}/${remote.repo} from GitHub needs GITHUB_TOKEN (try: GITHUB_TOKEN=$(gh auth token)).`);
	return { snapshot: await fetchGithubSnapshot(remote.owner, remote.repo, { token, allowPrivate: true }) };
}

function paint(enabled: boolean) {
	const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
	return { bold: wrap('1'), dim: wrap('2'), green: wrap('32'), yellow: wrap('33'), red: wrap('31') };
}

function gradeTone(c: ReturnType<typeof paint>, grade: Grade) {
	return grade.startsWith('A') || grade.startsWith('B') ? c.green : grade.startsWith('C') ? c.yellow : c.red;
}

function renderText(snapshot: RepoSnapshot, color: boolean): string {
	const c = paint(color);
	const g = gradeSnapshot(snapshot);
	const review = templateReview(snapshot, g.checks);
	const out: string[] = [];
	const ref = snapshot.owner === 'local' ? snapshot.name : `${snapshot.owner}/${snapshot.name}`;
	out.push(`${c.bold(ref)}  ${gradeTone(c, g.grade)(c.bold(g.grade))} ${c.dim(`(${g.score}/100)`)}`);
	if (g.ecosystems.length) out.push(c.dim(`Detected: ${g.ecosystems.join(', ')}`));
	out.push('');

	const width = Math.max(...g.categories.map((cat) => cat.label.length));
	for (const id of CATEGORY_ORDER) {
		const cat = g.categories.find((x) => x.id === id);
		if (!cat) continue;
		const filled = Math.round((cat.points / cat.max) * 10);
		const bar = '█'.repeat(filled) + c.dim('░'.repeat(10 - filled));
		out.push(`  ${cat.label.padEnd(width)}  ${bar}  ${String(cat.points).padStart(2)}/${cat.max}`);
	}

	const open = g.checks.filter((x) => x.status !== 'pass');
	if (open.length) {
		out.push('', c.bold('Checks to fix'));
		for (const x of open) {
			const mark = x.status === 'partial' ? c.yellow('◐') : c.red('✗');
			out.push(`  ${mark} ${x.label} ${c.dim(`(${x.points}/${x.max})`)}`, `    ${c.dim(x.detail)}`);
		}
	}

	if (review.fixes.length) {
		out.push('', c.bold('Suggested fixes'));
		review.fixes.forEach((f, i) => {
			out.push(`  ${i + 1}. ${f.title}`, `     ${c.dim(f.why)}`);
			if (f.snippet) {
				if (f.path) out.push(`     ${c.dim(`${f.path}:`)}`);
				out.push(
					...f.snippet
						.trimEnd()
						.split('\n')
						.map((l) => `     ${c.dim('│')} ${l}`)
				);
			}
		});
		out.push('', c.dim('For fixes written for this repo, run: agent-ready --prompt | claude -p'));
	} else {
		out.push('', c.green('Every check passes.'));
	}
	return out.join('\n');
}

export async function main(argv: string[]): Promise<number> {
	let args: ReturnType<typeof parse>;
	function parse() {
		return parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				json: { type: 'boolean' },
				prompt: { type: 'boolean' },
				'claude-md': { type: 'boolean' },
				'min-grade': { type: 'string' },
				'no-color': { type: 'boolean' },
				help: { type: 'boolean', short: 'h' },
				version: { type: 'boolean', short: 'v' }
			}
		});
	}
	try {
		args = parse();
	} catch (e) {
		process.stderr.write(`${(e as Error).message}\n\n${HELP}\n`);
		return 2;
	}
	const { values, positionals } = args;
	if (values.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	if (values.version) {
		process.stdout.write(`${version()}\n`);
		return 0;
	}

	try {
		if (positionals.length > 1) throw new UsageError('Give at most one target.');
		const minGrade = values['min-grade'];
		if (minGrade !== undefined && !isGrade(minGrade))
			throw new UsageError(`--min-grade must be a letter grade such as B or A-, not "${minGrade}".`);
		const outputs = [values.json, values.prompt, values['claude-md']].filter(Boolean).length;
		if (outputs > 1) throw new UsageError('Use only one of --json, --prompt and --claude-md.');

		const { snapshot, note } = await loadSnapshot(positionals[0] ?? '.');
		if (note) process.stderr.write(`note: ${note}\n`);
		const grading = gradeSnapshot(snapshot);

		if (values.json) {
			const review = templateReview(snapshot, grading.checks);
			const { owner, name: repo, description } = snapshot;
			process.stdout.write(`${JSON.stringify({ owner, repo, description, ...grading, review }, null, 2)}\n`);
		} else if (values.prompt) {
			process.stdout.write(
				`${REVIEW_SYSTEM_PROMPT}\n\n${buildReviewPrompt(snapshot, grading.checks)} Reply in Markdown with a Summary, Setup notes and Fixes section.\n`
			);
		} else if (values['claude-md']) {
			process.stdout.write(starterClaudeMd(snapshot));
		} else {
			const color = !values['no-color'] && !process.env.NO_COLOR && !!process.stdout.isTTY;
			process.stdout.write(`${renderText(snapshot, color)}\n`);
		}

		if (minGrade && !meetsGrade(grading.grade, minGrade)) {
			process.stderr.write(`Grade ${grading.grade} is below the minimum ${minGrade}.\n`);
			return 1;
		}
		return 0;
	} catch (e) {
		const msg = e instanceof UsageError || e instanceof SnapshotError ? e.message : `agent-ready failed: ${(e as Error).message}`;
		process.stderr.write(`${msg}\n`);
		return 2;
	}
}
