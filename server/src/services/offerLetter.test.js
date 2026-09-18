import { describe, it, expect, vi } from 'vitest';

// Every case below describes what happens with no Supabase configured, so the
// answer has to come from the test rather than from whatever is in the runner's
// .env. Reading the real client made these pass in CI, where the vars are
// absent, and fail on any machine set up to run the app.
vi.mock('../supabaseClient.js', () => ({
  default: { storage: {} },
  isSupabaseAvailable: () => false,
}));

import {
  DEFAULT_TEMPLATE,
  generateOfferLetterPdf,
  getOfferLetterTemplate,
  saveOfferLetterTemplate,
  uploadSignature,
  findLatestOfferLetterSend
} from './offerLetter.js';

describe('offerLetter', () => {
  const application = {
    id: 'app-1',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com'
  };
  const cycle = { id: 'cycle-1', name: 'Winter 2026' };

  it('generateOfferLetterPdf returns a non-empty PDF buffer', async () => {
    const offerDetails = {
      position: 'Associate',
      startDate: 'January 15, 2027',
      responseDeadline: 'Friday, January 23rd at 11:59 PM'
    };
    const template = {
      ...DEFAULT_TEMPLATE,
      presidentName: 'Anushka Makkar'
    };

    const pdfBuffer = await generateOfferLetterPdf(application, cycle, template, offerDetails, null);
    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.length).toBeGreaterThan(0);
    expect(pdfBuffer.toString('utf8', 0, 4)).toBe('%PDF');
  });

  it('does not hard-code a specific quarter in the default terms', () => {
    const combined = `${DEFAULT_TEMPLATE.introText} ${DEFAULT_TEMPLATE.terms.join(' ')} ${DEFAULT_TEMPLATE.closingText}`;
    expect(combined).not.toContain('Spring 2026');
  });

  it('substitutes candidate, position, cycle, and deadline placeholders into the PDF', async () => {
    const offerDetails = {
      position: 'TestPosition',
      startDate: 'TestStart',
      responseDeadline: 'TestDeadline'
    };
    const template = {
      ...DEFAULT_TEMPLATE,
      presidentName: 'PresidentName',
      introText: 'Hello {{candidateName}}, you are offered {{position}} for {{cycleName}} starting {{startDate}}. Reply by {{responseDeadline}}.',
      terms: ['Confirm {{position}} by {{responseDeadline}}'],
      closingText: 'See you {{startDate}}.'
    };

    const pdfBuffer = await generateOfferLetterPdf(application, cycle, template, offerDetails, null);
    expect(pdfBuffer.length).toBeGreaterThan(0);
    expect(pdfBuffer.toString('utf8', 0, 4)).toBe('%PDF');
  });

  it('returns the default template when Supabase is not configured', async () => {
    const template = await getOfferLetterTemplate('missing-cycle');
    expect(template).toBeTruthy();
    expect(template.presidentName).toBe('');
    expect(Array.isArray(template.terms)).toBe(true);
  });

  it('throws when saving a template without Supabase configured', async () => {
    await expect(() => saveOfferLetterTemplate('cycle-1', DEFAULT_TEMPLATE)).rejects.toThrow(/Supabase storage is not configured/);
  });

  it('throws when uploading a signature without Supabase configured', async () => {
    await expect(() => uploadSignature('cycle-1', Buffer.from('fake'), 'image/png')).rejects.toThrow(/Supabase storage is not configured/);
  });

  it('returns null for the latest send when Supabase is not configured', async () => {
    const latest = await findLatestOfferLetterSend('app-1');
    expect(latest).toBeNull();
  });
});
