// Shields-style flat badge, hand-built so README badges render with no extra dependencies.
import type { Grade } from './types.js';

export function gradeColor(grade: Grade | null): string {
	if (!grade) return '#9f9f9f';
	switch (grade[0]) {
		case 'A':
			return '#2ea44f';
		case 'B':
			return '#97ca00';
		case 'C':
			return '#dfb317';
		case 'D':
			return '#fe7d37';
		default:
			return '#e05d44';
	}
}

// Approximate Verdana 11px advance widths; close enough for short labels.
function textWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		if (/[il.:|' ]/.test(ch)) w += 3.5;
		else if (/[fjrt-]/.test(ch)) w += 4.5;
		else if (/[mwMW]/.test(ch)) w += 10;
		else if (/[A-Z+]/.test(ch)) w += 7.5;
		else w += 6.5;
	}
	return Math.round(w);
}

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function badgeSvg(grade: Grade | null, label = 'agent ready'): string {
	const value = grade ?? 'not graded';
	const lw = textWidth(label) + 12;
	const vw = textWidth(value) + 12;
	const w = lw + vw;
	const color = gradeColor(grade);
	const l = escapeXml(label);
	const v = escapeXml(value);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${v}"><title>${l}: ${v}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${l}</text><text x="${lw / 2}" y="14">${l}</text><text x="${lw + vw / 2}" y="15" fill="#010101" fill-opacity=".3">${v}</text><text x="${lw + vw / 2}" y="14">${v}</text></g></svg>`;
}
