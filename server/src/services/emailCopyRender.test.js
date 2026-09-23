import { describe, it, expect } from 'vitest';
import {
  copyHtml,
  copyLine,
  copySignOff,
  copySubject,
  escapeCopyHtml,
  fillMergeFields,
  mergeFieldsUsed,
} from './emailCopyRender.js';

describe('merge fields', () => {
  it('fills a placeholder from its value', () => {
    expect(fillMergeFields('Hi {{name}},', { name: 'Jordan' })).toBe('Hi Jordan,');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(fillMergeFields('Hi {{ name }},', { name: 'Jordan' })).toBe('Hi Jordan,');
  });

  it('leaves a placeholder nobody supplied standing, rather than blanking it', () => {
    // A typo an admin can see beats a sentence with a silent hole in it. The
    // save path refuses unknown placeholders, so this should only ever be a bug
    // in the shipped wording.
    expect(fillMergeFields('Hi {{nmae}},', { name: 'Jordan' })).toBe('Hi {{nmae}},');
  });

  it('renders a supplied null as nothing', () => {
    expect(fillMergeFields('Hi {{name}}.', { name: null })).toBe('Hi .');
  });

  it('escapes what a person typed', () => {
    expect(fillMergeFields('{{name}}', { name: '<script>alert(1)</script>' })).not.toContain('<script>');
    expect(fillMergeFields('{{name}}', { name: '<script>' })).toContain('&lt;script&gt;');
  });

  it('leaves a trusted value alone, so a composed link renders as a link', () => {
    const link = { value: '[Sign in](https://ats.example/login)', trusted: true };
    expect(fillMergeFields('{{cta}}', { cta: link })).toBe('[Sign in](https://ats.example/login)');
  });

  it('lists the placeholders a piece of copy uses, once each, in order', () => {
    expect(mergeFieldsUsed('{{b}} then {{a}} then {{b}}')).toEqual(['b', 'a']);
    expect(mergeFieldsUsed('nothing here')).toEqual([]);
  });

  it('escapes the five characters that matter in HTML', () => {
    expect(escapeCopyHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('subjects', () => {
  it('fills placeholders without escaping, because a header is not HTML', () => {
    expect(copySubject('Hi {{name}}', { name: "O'Brien" })).toBe("Hi O'Brien");
  });

  it('keeps a subject on one line, whatever was pasted into a name', () => {
    const subject = copySubject('Hi {{name}}', { name: 'Sam\nBcc: someone@example.com' });
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

describe('single-line copy', () => {
  it('escapes the value but not the sentence around it', () => {
    expect(copyLine('Dear {{name}},', { name: '<b>' })).toBe('Dear &lt;b&gt;,');
  });

  it('does not parse Markdown, so a heading stays a heading', () => {
    expect(copyLine('# Not a heading', {})).toBe('# Not a heading');
  });
});

describe('copy blocks', () => {
  it('gives every paragraph an inline style, because mail clients drop stylesheets', () => {
    const html = copyHtml('One.\n\nTwo.', {});
    expect(html.match(/<p style="[^"]+">/g)).toHaveLength(2);
    expect(html).not.toMatch(/<p>/);
  });

  it('styles lists and links too', () => {
    const html = copyHtml('- [Open the ATS](https://ats.example)', {});
    expect(html).toMatch(/<ul style="[^"]+">/);
    expect(html).toMatch(/<li style="[^"]+">/);
    expect(html).toMatch(/<a style="color: [^"]+;" href="https:\/\/ats\.example"/);
  });

  it('takes the colour and spacing of the card it is drawn into', () => {
    const inCard = copyHtml('Line.', {}, { color: '#155724', spacing: 'snug' });
    expect(inCard).toContain('color: #155724');
    expect(inCard).toContain('margin: 5px 0');
  });

  it('renders Markdown emphasis, so an admin can bold a round name', () => {
    expect(copyHtml('the **Final Round**', {})).toContain('<strong>Final Round</strong>');
  });

  it('escapes a merge field value even inside Markdown', () => {
    const html = copyHtml('Hi {{name}}', { name: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('renders nothing at all for an empty field', () => {
    expect(copyHtml('', {})).toBe('');
    expect(copyHtml('   ', {})).toBe('');
  });
});

describe('sign-offs', () => {
  it('keeps the line break, which is the whole point of the field', () => {
    expect(copySignOff('Best regards,\nUConsulting', {})).toContain('Best regards,<br>UConsulting');
  });

  it('is one paragraph, not two', () => {
    expect(copySignOff('Best regards,\nUConsulting', {}).match(/<p /g)).toHaveLength(1);
  });

  it('renders nothing for an empty sign-off', () => {
    expect(copySignOff('', {})).toBe('');
  });
});

describe('copy cannot reach past the words', () => {
  // The editor promises an edit changes what an email says and not how it is
  // built. Markdown hands raw HTML straight through, so without this the
  // promise would be false for anybody who typed a tag.
  it('prints a tag somebody typed instead of building it', () => {
    const html = copyHtml('<div style="display:none">gone</div>', {});
    expect(html).not.toContain('<div');
    expect(html).toContain('&lt;div');
  });

  it('prints a script tag rather than embedding one', () => {
    const html = copyHtml('<script>alert(1)</script>', {});
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script');
  });

  it('does the same in a heading and a sign-off', () => {
    expect(copyLine('<b>Big</b>', {})).not.toContain('<b>');
    expect(copySignOff('<b>Best</b>,\nUConsulting', {})).not.toContain('<b>');
  });

  it('still renders Markdown, which is the point of allowing any of it', () => {
    const html = copyHtml('the **Final Round**, see [the ATS](https://ats.example)', {});
    expect(html).toContain('<strong>Final Round</strong>');
    expect(html).toContain('href="https://ats.example"');
  });

  it('leaves a less-than that is not a tag alone', () => {
    expect(copyHtml('5 < 10 and <3', {})).toContain('5 &lt; 10 and &lt;3');
  });

  it('points a javascript: link at nothing', () => {
    const html = copyHtml('[click](javascript:alert(1))', {});
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('points a data: link at nothing', () => {
    expect(copyHtml('[click](data:text/html,<script>alert(1)</script>)', {})).not.toContain('data:text/html');
  });

  it('keeps the schemes an email actually uses', () => {
    expect(copyHtml('[a](https://ats.example)', {})).toContain('href="https://ats.example"');
    expect(copyHtml('[b](mailto:recruitment@example.com)', {})).toContain('href="mailto:recruitment@example.com"');
  });

  it('does not escape a trusted value, which carries composed Markdown', () => {
    const cta = { value: '[Sign in](https://ats.example/login)', trusted: true };
    expect(copyHtml('{{cta}}', { cta })).toContain('href="https://ats.example/login"');
  });
});
