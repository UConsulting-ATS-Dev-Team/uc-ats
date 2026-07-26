import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(Buffer.isBuffer(pdfBuffer));
    assert.ok(pdfBuffer.length > 0);
    assert.equal(pdfBuffer.toString('utf8', 0, 4), '%PDF');
  });

  it('does not hard-code a specific quarter in the default terms', () => {
    const combined = `${DEFAULT_TEMPLATE.introText} ${DEFAULT_TEMPLATE.terms.join(' ')} ${DEFAULT_TEMPLATE.closingText}`;
    assert.ok(!combined.includes('Spring 2026'), 'Default template should not hard-code Spring 2026');
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
    assert.ok(pdfBuffer.length > 0);
    assert.equal(pdfBuffer.toString('utf8', 0, 4), '%PDF');
  });

  it('returns the default template when Supabase is not configured', async () => {
    const template = await getOfferLetterTemplate('missing-cycle');
    assert.ok(template);
    assert.equal(template.presidentName, '');
    assert.ok(Array.isArray(template.terms));
  });

  it('throws when saving a template without Supabase configured', async () => {
    await assert.rejects(
      () => saveOfferLetterTemplate('cycle-1', DEFAULT_TEMPLATE),
      /Supabase storage is not configured/
    );
  });

  it('throws when uploading a signature without Supabase configured', async () => {
    await assert.rejects(
      () => uploadSignature('cycle-1', Buffer.from('fake'), 'image/png'),
      /Supabase storage is not configured/
    );
  });

  it('returns null for the latest send when Supabase is not configured', async () => {
    const latest = await findLatestOfferLetterSend('app-1');
    assert.equal(latest, null);
  });
});
