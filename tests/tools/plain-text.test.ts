import { describe, it, expect } from 'vitest';
import { markdownToPlainText } from '../../src/tools/plain-text.js';

const conv = (s: string) => markdownToPlainText(s).text;

describe('markdownToPlainText', () => {
  describe('passes plain text through untouched', () => {
    it.each([
      ['empty', ''],
      ['a sentence', 'Pickup is at 3:15 on Friday.'],
      ['blank-line paragraphs', 'One.\n\nTwo.\n\n\nThree.'],
      ['arithmetic with spaced stars', 'It costs 3 * 4 * 5 dollars.'],
      ['snake_case and file names', 'See my_file_name.pdf and a_b_c.'],
      ['a lone year-like number line', 'Last year was hard.\n2026. Was a hard year'],
      ['a mid-paragraph numbered line', 'We agreed on two things.\n1. Also, the dentist.'],
      ['strikethrough (meaning would invert)', 'Pickup at ~~4pm~~ 5pm'],
      ['blockquotes', '> what you wrote\nmy reply'],
      ['a bare url', 'Form: https://example.com/a_b_c?x=1*2'],
      ['already-plain bullets', '- one\n- two'],
      ['an email address', 'mail me at a_b@example.com'],
    ])('%s', (_name, input) => {
      const r = markdownToPlainText(input);
      expect(r.text).toBe(input);
      expect(r.changes).toEqual([]);
    });
  });

  describe('inline markdown', () => {
    it('strips bold', () => {
      expect(conv('This is **urgent** and __also__ this.')).toBe('This is urgent and also this.');
    });

    it('strips italic with * and _', () => {
      expect(conv('A *quick* note and _another_ one.')).toBe('A quick note and another one.');
    });

    it('strips bold-italic and nested emphasis', () => {
      expect(conv('***very*** and **a *b* c**')).toBe('very and a b c');
    });

    it('does not treat word-internal underscores or stars as emphasis', () => {
      expect(conv('snake_case_name and a*b*c')).toBe('snake_case_name and a*b*c');
    });

    it('does not treat spaced stars as emphasis', () => {
      expect(conv('2 * 3 and 4 * 5')).toBe('2 * 3 and 4 * 5');
    });

    it('rewrites links as "text (url)"', () => {
      expect(conv('Fill in [the form](https://example.com/f) please.'))
        .toBe('Fill in the form (https://example.com/f) please.');
    });

    it('collapses a link whose text is its url', () => {
      expect(conv('[https://example.com](https://example.com) and [example.com](https://example.com)'))
        .toBe('https://example.com and https://example.com');
    });

    it('rewrites images as "alt (url)"', () => {
      expect(conv('![receipt](https://example.com/r.png)')).toBe('receipt (https://example.com/r.png)');
    });

    it('unwraps autolinks', () => {
      expect(conv('See <https://example.com/x>.')).toBe('See https://example.com/x.');
    });

    it('leaves inline code spans exactly as written, including markdown inside them', () => {
      expect(conv('Run `a **b** c` then **go**')).toBe('Run `a **b** c` then go');
    });

    it('leaves a line holding its own private-use placeholder characters alone', () => {
      const s = 'odd \uE0000\uE001 **x**';
      expect(conv(s)).toBe(s);
    });

    it('converts emphasis inside link text', () => {
      expect(conv('[**the form**](https://example.com)')).toBe('the form (https://example.com)');
    });
  });

  describe('headings', () => {
    it('strips ATX heading markers', () => {
      expect(conv('# Plan\n## Friday ##\nText')).toBe('Plan\nFriday\nText');
    });

    it('requires a space after the hashes', () => {
      expect(conv('#hashtag stays')).toBe('#hashtag stays');
    });

    it('converts inline markdown inside a heading', () => {
      expect(conv('## **Schedule**')).toBe('Schedule');
    });
  });

  describe('fenced code', () => {
    it('leaves a fenced block untouched, fences included', () => {
      const s = 'Before **x**\n```\n# not a heading\n**raw**\n```\nAfter **y**';
      expect(conv(s)).toBe('Before x\n```\n# not a heading\n**raw**\n```\nAfter y');
    });

    it('treats an unclosed fence as running to the end', () => {
      expect(conv('```\n**raw**')).toBe('```\n**raw**');
    });

    it('supports ~~~ fences', () => {
      expect(conv('~~~\n* raw\n~~~')).toBe('~~~\n* raw\n~~~');
    });
  });

  describe('bullet lists', () => {
    it('normalizes * and + markers to -', () => {
      expect(conv('* one\n+ two\n- three')).toBe('- one\n- two\n- three');
    });

    it('indents nested levels by 4 spaces', () => {
      expect(conv('- a\n  - b\n    - c\n- d')).toBe('- a\n    - b\n        - c\n- d');
    });

    it('treats a tab as one nesting step', () => {
      expect(conv('- a\n\t- b')).toBe('- a\n    - b');
    });

    it('dedents back to a shallower sibling', () => {
      expect(conv('- a\n   - b\n - c')).toBe('- a\n    - b\n- c');
    });

    it('collapses extra space after the marker', () => {
      expect(conv('-    spaced')).toBe('- spaced');
    });

    it('converts inline markdown inside items', () => {
      expect(conv('- **Friday** pickup')).toBe('- Friday pickup');
    });

    it('starts a bullet list right after a prose line', () => {
      expect(conv('Plan:\n* a\n* b')).toBe('Plan:\n- a\n- b');
    });

    it('keeps a blank line between items (loose list)', () => {
      expect(conv('1. a\n\n1. b')).toBe('1. a\n\n2. b');
    });

    it('keeps an indented continuation line inside the list', () => {
      expect(conv('1. a\n   more about a\n1. b')).toBe('1. a\n   more about a\n2. b');
    });

    it('ends the list at an unindented prose line', () => {
      expect(conv('1. a\n1. b\nThanks.\n1. c')).toBe('1. a\n2. b\nThanks.\n1. c');
    });
  });

  describe('numbered lists', () => {
    it('renumbers lazy 1. 1. 1.', () => {
      expect(conv('1. a\n1. b\n1. c')).toBe('1. a\n2. b\n3. c');
    });

    it('renumbers out-of-order numbers from the first', () => {
      expect(conv('1. a\n5. b\n2. c')).toBe('1. a\n2. b\n3. c');
    });

    it('preserves a non-1 start', () => {
      expect(conv('3. a\n3. b')).toBe('3. a\n4. b');
    });

    it('accepts 1) and writes 1.', () => {
      expect(conv('1) a\n2) b')).toBe('1. a\n2. b');
    });

    it('starts a numbered list after a prose line only when it starts at 1', () => {
      expect(conv('Here is the plan:\n1. a\n1. b')).toBe('Here is the plan:\n1. a\n2. b');
      expect(conv('Here is the plan:\n4. a\n4. b')).toBe('Here is the plan:\n4. a\n4. b');
    });

    it('starts after a blank line at any number', () => {
      expect(conv('Intro\n\n4. a\n4. b')).toBe('Intro\n\n4. a\n5. b');
    });

    it('letters the second level', () => {
      expect(conv('1. Friday\n   1. school\n   1. cleats\n1. Sunday'))
        .toBe('1. Friday\n    a. school\n    b. cleats\n2. Sunday');
    });

    it('numbers the third level again', () => {
      expect(conv('1. a\n   1. b\n      1. c\n      1. d'))
        .toBe('1. a\n    a. b\n        1. c\n        2. d');
    });

    it('restarts numbering for each nested list', () => {
      expect(conv('1. a\n   1. x\n   1. y\n1. b\n   1. z'))
        .toBe('1. a\n    a. x\n    b. y\n2. b\n    a. z');
    });

    it('keeps a lettered start written by the caller', () => {
      expect(conv('1. a\n    c. x\n    c. y')).toBe('1. a\n    c. x\n    d. y');
    });

    it('runs letters past z', () => {
      const items = Array.from({ length: 28 }, (_, i) => `   1. i${i}`).join('\n');
      const out = conv(`1. top\n${items}`).split('\n');
      expect(out[26]).toBe('    z.  i25');
      expect(out[27]).toBe('    aa. i26');
    });

    it('pads markers so item text aligns at 10+', () => {
      const src = Array.from({ length: 10 }, (_, i) => `1. item${i + 1}`).join('\n');
      const out = conv(src).split('\n');
      expect(out[0]).toBe('1.  item1');
      expect(out[8]).toBe('9.  item9');
      expect(out[9]).toBe('10. item10');
    });

    it('nests bullets under numbers and keeps them as -', () => {
      expect(conv('1. a\n   * x\n1. b')).toBe('1. a\n    - x\n2. b');
    });

    it('restarts when the marker type changes at the same level', () => {
      expect(conv('1. a\n1. b\n- c\n1. d')).toBe('1. a\n2. b\n- c\n1. d');
    });

    it('leaves a lone numbered line unchanged', () => {
      expect(conv('Intro\n\n2026. Was a year')).toBe('Intro\n\n2026. Was a year');
    });
  });

  describe('line endings', () => {
    it('preserves CRLF', () => {
      expect(conv('**a**\r\n* b\r\n* c')).toBe('a\r\n- b\r\n- c');
    });
  });

  describe('is idempotent', () => {
    it.each([
      '1. Friday\n   1. school\n   1. cleats\n      1. deep\n1. Sunday',
      Array.from({ length: 12 }, (_, i) => `1. item${i}`).join('\n'),
      '# H\n**b** _i_ [l](https://e.com) `c **d**`\n- a\n  - b\n    + c',
      '```\n**x**\n```\n* a',
      'Plan:\n1. a\n   * x\n   * y\n1. b\n\n10. c\n10. d',
    ])('%#', (src) => {
      const once = conv(src);
      expect(conv(once)).toBe(once);
    });
  });

  describe('reports what changed', () => {
    it('names each category once', () => {
      const r = markdownToPlainText('# H\n**b** [l](https://e.com)\n* a\n* b\n\n1. x\n1. y\n  - z');
      expect(r.changes).toEqual(['headings', 'bold/italic', 'links', 'list markers', 'list numbering', 'list indentation']);
    });

    it('reports nothing when the output equals the input', () => {
      expect(markdownToPlainText('1. a\n2. b').changes).toEqual([]);
    });
  });
});
