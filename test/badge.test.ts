import { describe, expect, it } from 'vitest';
import { badgeSvg, gradeColor } from '../src/badge.js';

describe('badgeSvg', () => {
	it('renders the grade with its color', () => {
		const svg = badgeSvg('B+');
		expect(svg).toContain('agent ready: B+');
		expect(svg).toContain(gradeColor('B+'));
		expect(svg.startsWith('<svg')).toBe(true);
	});

	it('renders a grey not-graded badge', () => {
		const svg = badgeSvg(null);
		expect(svg).toContain('not graded');
		expect(svg).toContain('#9f9f9f');
	});

	it('escapes XML in labels', () => {
		expect(badgeSvg('A', 'a<b>&"c')).toContain('a&lt;b&gt;&amp;&quot;c');
	});

	it('is wider for longer values', () => {
		const width = (s: string) => Number(/width="(\d+)"/.exec(s)![1]);
		expect(width(badgeSvg(null))).toBeGreaterThan(width(badgeSvg('A')));
	});

	it('colors by letter', () => {
		expect(gradeColor('A+')).toBe(gradeColor('A-'));
		expect(gradeColor('F')).not.toBe(gradeColor('A'));
	});
});
