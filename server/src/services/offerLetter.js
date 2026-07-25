import { randomUUID } from 'crypto';
import pdfmake from 'pdfmake';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';
import { sendOfferLetter } from './emailNotifications.js';

// Lock down pdfmake so it does not try to fetch external URLs.
if (pdfmake.setUrlAccessPolicy) {
  pdfmake.setUrlAccessPolicy(() => false);
}

// Standard 14 fonts are built into PDF viewers and not local files.
const STANDARD_14_FONTS = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
  'Symbol', 'ZapfDingbats'
]);
if (pdfmake.setLocalAccessPolicy) {
  pdfmake.setLocalAccessPolicy((path) => STANDARD_14_FONTS.has(path));
}

pdfmake.addFonts({
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique'
  }
});

const TEMPLATE_BUCKET = 'offer-letter-templates';
const SIGNATURE_BUCKET = 'signatures';
const SEND_BUCKET = 'offer-letter-sends';

export const DEFAULT_TEMPLATE = {
  introText:
    "Congratulations! Our team is beyond excited to extend you an offer for a position in UConsulting's (UC) {{cycleName}} Intern class. This quarter's recruitment cycle was extremely competitive. Through this process, we have determined that the combination of your business acumen, professional ambition, and unique personal qualities make you an exceptional candidate to join our UC Family.\n\n" +
    "UConsulting is composed of some of UCLA's brightest minds and most successful current students and alumni. From holding positions at elite consulting firms such as McKinsey, BCG, Bain, EY-Parthenon, Deloitte Consulting, LEK, and others, to attending Stanford Business School and beyond — the UC Family provides the resources and mentorship to guide you in your professional journey.\n\n" +
    "Along with the extensive community and network that UConsulting offers its members, you will have the opportunity to train, develop, and perfect your business skills through our Accelerator Program, consulting projects, and professional workshops. We, at UC, also believe it is our mission to build, support, and guide the UCLA campus community through the competitive business landscape and hope you will play an integral role in carrying out this goal.",
  terms: [
    'Attend all Accelerator Program workshops and events',
    'Complete ~3 coffee chats with current/new members per week throughout the quarter',
    'Participate on a client project during the upcoming quarter and at least one more during your time in UC'
  ],
  closingText:
    'If you choose to accept, please return a signed PDF copy to uconsultingla@gmail.com by {{responseDeadline}}.\n\nWe look forward to having you on the team!',
  checklist: [
    'I will participate in all required events',
    'I will maintain academic and professional integrity',
    'I understand that the UC recruitment process and this offer letter are confidential in their entirety'
  ],
  presidentName: '',
  presidentTitle: 'President, UConsulting',
  signatureLabel: 'Signature',
  printedNameLabel: 'Printed Name',
  officialOfferLabel: 'OFFICIAL OFFER LETTER',
  confidentialityLabel: 'U C STRICTLY CONFIDENTIAL'
};

function latestTemplatePath(cycleId) {
  return `${cycleId}/latest.json`;
}

function versionedTemplatePath(cycleId, versionId) {
  return `${cycleId}/${versionId}.json`;
}

function signaturePath(cycleId, ext) {
  return `${cycleId}/signature${ext}`;
}

function sendRecordPath(applicationId, sendId) {
  return `sends/${applicationId}/${sendId}.json`;
}

function latestSendPath(applicationId) {
  return `sends/${applicationId}/latest.json`;
}

async function ensureBucket(name, isPublic = false) {
  if (!isSupabaseAvailable()) return;
  try {
    const { data, error } = await supabase.storage.getBucket(name);
    if (data && !error) return;
  } catch (e) {
    // ignore, try to create
  }
  try {
    const { error } = await supabase.storage.createBucket(name, { public: isPublic });
    if (error) {
      console.warn(`[ensureBucket] ${name}:`, error.message);
    }
  } catch (e) {
    console.warn(`[ensureBucket] ${name}:`, e.message);
  }
}

async function uploadJson(bucket, path, payload, isPublic = false) {
  await ensureBucket(bucket, isPublic);
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, Buffer.from(JSON.stringify(payload, null, 2)), {
      contentType: 'application/json',
      upsert: true
    });
  if (error) throw error;
}

async function downloadJson(bucket, path) {
  try {
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) return null;
    const text = await data.text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function substitutePlaceholders(text, values) {
  return Object.entries(values).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || ''),
    text
  );
}

export async function getOfferLetterTemplate(cycleId) {
  if (!isSupabaseAvailable()) {
    return JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
  }
  const record = await downloadJson(TEMPLATE_BUCKET, latestTemplatePath(cycleId));
  if (record) {
    return { ...DEFAULT_TEMPLATE, ...record };
  }
  return JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
}

export async function saveOfferLetterTemplate(cycleId, template) {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase storage is not configured');
  }
  const versionId = randomUUID();
  const payload = { ...template, versionId, savedAt: new Date().toISOString() };
  // Keep an immutable version history and a mutable "latest" pointer.
  await uploadJson(TEMPLATE_BUCKET, versionedTemplatePath(cycleId, versionId), payload, false);
  await uploadJson(TEMPLATE_BUCKET, latestTemplatePath(cycleId), payload, false);
  return payload;
}

export async function uploadSignature(cycleId, buffer, contentType) {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase storage is not configured');
  }
  const ext = contentType === 'image/jpeg' ? '.jpg' : contentType === 'image/webp' ? '.webp' : '.png';
  const path = signaturePath(cycleId, ext);
  await ensureBucket(SIGNATURE_BUCKET, false);
  const { error } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  return { path, contentType };
}

export async function getSignatureBuffer(signaturePath) {
  if (!signaturePath || !isSupabaseAvailable()) return null;
  try {
    const { data, error } = await supabase.storage.from(SIGNATURE_BUCKET).download(signaturePath);
    if (error || !data) return null;
    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (e) {
    console.warn('[getSignatureBuffer] error:', e.message);
    return null;
  }
}

export async function getSignatureSignedUrl(signaturePath, expiresIn = 300) {
  if (!signaturePath || !isSupabaseAvailable()) return null;
  try {
    const { data, error } = await supabase.storage
      .from(SIGNATURE_BUCKET)
      .createSignedUrl(signaturePath, expiresIn);
    if (error) {
      console.warn('[getSignatureSignedUrl] error:', error.message);
      return null;
    }
    return data?.signedUrl || null;
  } catch (e) {
    console.warn('[getSignatureSignedUrl] error:', e.message);
    return null;
  }
}

export async function findLatestOfferLetterSend(applicationId) {
  if (!isSupabaseAvailable()) return null;
  return downloadJson(SEND_BUCKET, latestSendPath(applicationId));
}

export async function createOfferLetterSendRecord(application, cycle, template, offerDetails, approverUserId, force = false) {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase storage is not configured');
  }

  const sendId = randomUUID();
  const applicationId = application.id;
  const record = {
    id: sendId,
    idempotencyKey: sendId,
    applicationId,
    candidateEmail: application.email,
    candidateName: `${application.firstName} ${application.lastName}`,
    position: offerDetails.position,
    startDate: offerDetails.startDate,
    responseDeadline: offerDetails.responseDeadline,
    cycleId: cycle?.id || application.cycleId,
    cycleName: cycle?.name || 'UConsulting',
    templateSnapshot: { ...template },
    signaturePath: template.signaturePath,
    presidentName: template.presidentName,
    presidentTitle: template.presidentTitle,
    approverUserId,
    force,
    status: 'pending',
    messageId: null,
    provider: 'ses',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await ensureBucket(SEND_BUCKET, false);
  await uploadJson(SEND_BUCKET, sendRecordPath(applicationId, sendId), record, false);
  await uploadJson(SEND_BUCKET, latestSendPath(applicationId), record, false);
  return record;
}

export async function updateOfferLetterSendRecord(applicationId, sendId, { status, messageId, error }) {
  if (!isSupabaseAvailable()) return;
  const path = sendRecordPath(applicationId, sendId);
  const existing = await downloadJson(SEND_BUCKET, path);
  if (!existing) {
    console.warn(`[updateOfferLetterSendRecord] record not found: ${path}`);
    return;
  }
  const updated = {
    ...existing,
    status,
    messageId: messageId || existing.messageId,
    error: error || existing.error,
    updatedAt: new Date().toISOString()
  };
  await uploadJson(SEND_BUCKET, path, updated, false);
  // Keep the latest pointer in sync so duplicate checks are accurate.
  await uploadJson(SEND_BUCKET, latestSendPath(applicationId), updated, false);
  return updated;
}

export async function sendOfferLetterToCandidate(application, cycle, template, signatureBuffer, offerDetails, approverUserId, force = false) {
  const applicationId = application.id;

  if (!force) {
    const latestSend = await findLatestOfferLetterSend(applicationId);
    if (latestSend && (latestSend.status === 'sent' || latestSend.status === 'pending')) {
      return {
        success: false,
        alreadySent: true,
        error: 'An offer letter has already been sent or is in progress for this application. Use force=true to resend.'
      };
    }
  }

  let sendRecord;
  try {
    sendRecord = await createOfferLetterSendRecord(application, cycle, template, offerDetails, approverUserId, force);

    const deadline = offerDetails.responseDeadline || template.responseDeadline || '';
    const pdfOfferDetails = {
      position: offerDetails.position,
      startDate: offerDetails.startDate,
      responseDeadline: deadline,
      additionalNotes: offerDetails.additionalNotes
    };
    const pdfBuffer = await generateOfferLetterPdf(application, cycle, template, pdfOfferDetails, signatureBuffer);

    const emailResult = await sendOfferLetter(
      application.email,
      `${application.firstName} ${application.lastName}`,
      cycle?.name || 'UConsulting',
      pdfOfferDetails,
      pdfBuffer,
      'UConsulting-Offer-Letter.pdf'
    );

    if (!emailResult.success) {
      await updateOfferLetterSendRecord(applicationId, sendRecord.id, { status: 'failed', error: emailResult.error });
      return { success: false, error: emailResult.error };
    }

    await updateOfferLetterSendRecord(applicationId, sendRecord.id, { status: 'sent', messageId: emailResult.messageId });
    return { success: true, messageId: emailResult.messageId };
  } catch (error) {
    if (sendRecord) {
      try {
        await updateOfferLetterSendRecord(applicationId, sendRecord.id, { status: 'failed', error: error.message });
      } catch (auditError) {
        console.error('[sendOfferLetterToCandidate] failed to update audit record:', auditError);
      }
    }
    return { success: false, error: error.message };
  }
}

export async function generateOfferLetterPdf(application, cycle, template, offerDetails, signatureBuffer) {
  const candidateName = `${application.firstName} ${application.lastName}`;
  const responseDeadline = offerDetails.responseDeadline || template.responseDeadline || 'the deadline specified by the recruitment team';
  const position = offerDetails.position || 'Associate';
  const cycleName = cycle?.name || 'UConsulting';
  const startDate = offerDetails.startDate || 'To be determined';

  const values = {
    candidateName,
    position,
    cycleName,
    startDate,
    responseDeadline
  };

  const introParagraphs = substitutePlaceholders(template.introText || DEFAULT_TEMPLATE.introText, values)
    .split('\n\n')
    .filter(Boolean);
  const closingParagraphs = substitutePlaceholders(template.closingText || DEFAULT_TEMPLATE.closingText, values)
    .split('\n\n')
    .filter(Boolean);
  const terms = (template.terms || DEFAULT_TEMPLATE.terms).map((t) => substitutePlaceholders(t, values));
  const checklist = (template.checklist || DEFAULT_TEMPLATE.checklist).map((t) => `[ ] ${substitutePlaceholders(t, values)}`);

  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const content = [];

  content.push({
    columns: [
      { width: '*', text: '' },
      {
        width: 'auto',
        stack: [
          { text: template.officialOfferLabel || DEFAULT_TEMPLATE.officialOfferLabel, bold: true, fontSize: 12, alignment: 'right' },
          { text: today, alignment: 'right', margin: [0, 2, 0, 0] }
        ]
      }
    ],
    margin: [0, 0, 0, 20]
  });

  content.push({ text: `Dear ${candidateName},`, margin: [0, 0, 0, 10] });

  for (const p of introParagraphs) {
    content.push({ text: p, margin: [0, 0, 0, 10], lineHeight: 1.4 });
  }

  content.push({
    text: 'As a new member, your expectations are as follows:',
    margin: [0, 10, 0, 5]
  });
  content.push({
    ul: terms,
    margin: [20, 0, 0, 10]
  });

  for (const p of closingParagraphs) {
    content.push({ text: p, margin: [0, 0, 0, 10], lineHeight: 1.4 });
  }

  const signatureBlock = {
    margin: [0, 10, 0, 0],
    stack: []
  };

  if (signatureBuffer) {
    const signatureDataUri = `data:${extToContentTypeFromBuffer(signatureBuffer)};base64,${signatureBuffer.toString('base64')}`;
    signatureBlock.stack.push({ image: signatureDataUri, fit: [120, 60], margin: [0, 0, 0, 4] });
  }

  signatureBlock.stack.push(
    { text: template.presidentName || DEFAULT_TEMPLATE.presidentName, bold: true },
    { text: template.presidentTitle || DEFAULT_TEMPLATE.presidentTitle, margin: [0, 0, 0, 20] }
  );

  content.push(signatureBlock);

  content.push({
    text: 'Please check the boxes and sign below:',
    margin: [0, 10, 0, 8]
  });

  for (const item of checklist) {
    content.push({ text: item, margin: [0, 0, 0, 6] });
  }

  content.push({
    margin: [0, 10, 0, 0],
    table: {
      widths: ['50%', '50%'],
      body: [
        [
          { text: (template.signatureLabel || DEFAULT_TEMPLATE.signatureLabel) + '\n\n' + '__________________________', margin: [0, 0, 10, 0] },
          { text: (template.printedNameLabel || DEFAULT_TEMPLATE.printedNameLabel) + '\n\n' + '__________________________', margin: [0, 0, 0, 0] }
        ]
      ]
    },
    layout: 'noBorders'
  });

  content.push({
    text: template.confidentialityLabel || DEFAULT_TEMPLATE.confidentialityLabel,
    alignment: 'center',
    margin: [0, 20, 0, 0],
    fontSize: 9,
    color: '#666'
  });

  const docDefinition = {
    pageMargins: [50, 50, 50, 50],
    defaultStyle: {
      font: 'Helvetica',
      fontSize: 11,
      color: '#333'
    },
    content
  };

  return new Promise((resolve, reject) => {
    try {
      const pdf = pdfmake.createPdf(docDefinition);
      pdf.getBuffer().then(resolve).catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

function extToContentTypeFromBuffer(buffer) {
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  }
  return 'image/png';
}
