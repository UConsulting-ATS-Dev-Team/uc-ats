import { describe, it, expect, beforeEach } from 'vitest';

import { handleClick } from './clickTracking';
import { queuedEvents, resetTracker } from './tracker';
import { reportError, resetErrorTracking } from './errorTracking';

beforeEach(() => {
  resetTracker();
  resetErrorTracking();
  document.body.innerHTML = '';
});

function clickOn(html, selector) {
  document.body.innerHTML = html;
  const target = document.querySelector(selector);
  handleClick({ target });
  return queuedEvents().filter((e) => e.type === 'click');
}

describe('click tracking', () => {
  it('records the nearest button, even when the click lands on its icon', () => {
    const [event] = clickOn('<button><svg><path id="icon"/></svg> Save changes</button>', '#icon');
    expect(event).toMatchObject({ type: 'click', name: 'Save changes', meta: { tag: 'button' } });
  });

  it('prefers data-track over aria-label over text', () => {
    expect(clickOn('<button data-track="Send decision" aria-label="x">Jane Doe</button>', 'button')[0].name).toBe('Send decision');
    resetTracker();
    expect(clickOn('<button aria-label="Close dialog">×</button>', 'button')[0].name).toBe('Close dialog');
  });

  it('masks addresses and caps long labels', () => {
    expect(clickOn('<a href="#">Email joe@ucla.edu</a>', 'a')[0].name).toBe('Email [email]');
    resetTracker();
    expect(clickOn(`<button>${'word '.repeat(40)}</button>`, 'button')[0].name.length).toBeLessThanOrEqual(60);
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
