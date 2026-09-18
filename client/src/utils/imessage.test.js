import { describe, it, expect } from 'vitest';
import { buildImessageUrl, toImessageText } from './imessage';

describe('toImessageText', () => {
  it('drops bold and italic marks instead of sending literal asterisks', () => {
    expect(toImessageText('**GBM** is *tonight*')).toBe('GBM is tonight');
  });

  it('writes links out so Messages can preview them', () => {
    expect(toImessageText('RSVP [here](https://uc.org/rsvp)')).toBe('RSVP here: https://uc.org/rsvp');
    expect(toImessageText('[https://uc.org](https://uc.org)')).toBe('https://uc.org');
    // The toolbar's placeholder text, left unedited.
    expect(toImessageText('[text](https://uc.org)')).toBe('https://uc.org');
  });

  it('turns list dashes into bullets and keeps line breaks', () => {
    expect(toImessageText('Bring:\n- laptop\n- resume')).toBe('Bring:\n• laptop\n• resume');
  });

  it('leaves bare URLs alone', () => {
    expect(toImessageText('See https://uc.org/a_b*c')).toBe('See https://uc.org/a_b*c');
  });
});

describe('buildImessageUrl', () => {
  it('puts every number in one conversation with the text encoded', () => {
    expect(buildImessageUrl(['+13105551234', '+13105555678'], 'Hi & welcome\nsee you'))
      .toBe('sms://open?addresses=+13105551234,+13105555678&body=Hi%20%26%20welcome%0Asee%20you');
  });

  it('does not list a number twice or include blanks', () => {
    expect(buildImessageUrl(['+1310', null, '+1310'], '')).toBe('sms://open?addresses=+1310');
  });
});
