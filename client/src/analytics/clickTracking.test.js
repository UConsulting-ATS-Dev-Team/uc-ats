import { describe, it, expect, beforeEach } from 'vitest';

import { handleClick, looksLikeUiCopy } from './clickTracking';
import { queuedEvents, resetTracker } from './tracker';
import { reportError, resetErrorTracking } from './errorTracking';

beforeEach(() => {
  resetTracker();
  resetErrorTracking();
  document.body.innerHTML = '';
});

function clickOn(html, selector) {
  resetTracker();
  document.body.innerHTML = html;
  handleClick({ target: document.querySelector(selector) });
  return queuedEvents().filter((e) => e.type === 'click');
}
const label = (html, selector) => clickOn(html, selector)[0]?.name;

describe('click labels', () => {
  it('records the nearest button, even when the click lands on its icon', () => {
    const [event] = clickOn('<button><svg><path id="icon"/></svg> Save changes</button>', '#icon');
    expect(event).toMatchObject({ type: 'click', name: 'Save changes', meta: { tag: 'button' } });
  });

  it('uses data-track before anything on screen', () => {
    expect(label('<button data-track="Send decision" aria-label="x">Jane Doe</button>', 'button')).toBe('Send decision');
  });

  it('keeps short fixed copy from aria-label or text', () => {
    expect(label('<button aria-label="Close dialog">×</button>', 'button')).toBe('Close dialog');
    expect(label('<button>Run rollup now</button>', 'button')).toBe('Run rollup now');
  });

  it('never records a name, a position or a vote on a button', () => {
    // RosterStrip's chip, before it had data-track.
    expect(label('<button aria-label="3. Jane Doe, Voted"></button>', 'button')).toBe('(button)');
    expect(label('<button>Message Maria Lopez</button>', 'button')).toBe('(button)');
    expect(label('<button>Email joe@ucla.edu</button>', 'button')).toBe('(button)');
  });

  it('records where a link goes, never its text', () => {
    expect(label('<a href="/applications/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b?tab=x">Jane Doe</a>', 'a')).toBe('→ /applications/:id');
    expect(label('<a href="https://www.linkedin.com/in/jane-doe">Jane on LinkedIn</a>', 'a')).toBe('→ www.linkedin.com');
  });

  it('records no text for anything in a table row or list', () => {
    expect(label('<table><tr><td><button>Advance</button></td></tr></table>', 'button')).toBe('(button in a list)');
    expect(label('<ul><li><div role="button" id="r">Priya</div></li></ul>', '#r')).toBe('(button in a list)');
  });

  it('never records form fields', () => {
    expect(clickOn('<label><input id="f" type="text" value="secret"/></label>', '#f')).toHaveLength(0);
    expect(clickOn('<div role="button"><textarea id="t"></textarea></div>', '#t')).toHaveLength(0);
  });

  it('honours data-no-track', () => {
    expect(clickOn('<div data-no-track><button id="b">Reveal password</button></div>', '#b')).toHaveLength(0);
  });

  it('ignores clicks on nothing clickable', () => {
    expect(clickOn('<p id="p">Just text</p>', '#p')).toHaveLength(0);
  });
});

describe('looksLikeUiCopy', () => {
  it.each(['Save', 'Save changes', 'Open', 'Next page', 'Performance'])('accepts %s', (t) => expect(looksLikeUiCopy(t)).toBe(true));
  it.each(['Jane Doe', 'Round 2', 'x'.repeat(41), 'one two three four five six', 'a@b.co', ''])('rejects %s', (t) =>
    expect(looksLikeUiCopy(t)).toBe(false)
  );
});

describe('reportError', () => {
  it('reports once per message per page within five seconds', () => {
    reportError('Cannot read properties of undefined');
    reportError('Cannot read properties of undefined');
    reportError('Something else');
    expect(queuedEvents().filter((e) => e.type === 'js_error').map((e) => e.name)).toEqual([
      'Cannot read properties of undefined',
      'Something else',
    ]);
  });
});
