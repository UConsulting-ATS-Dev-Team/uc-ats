import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
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

let LOGO_SVG = null;
try {
  LOGO_SVG = readFileSync(
    fileURLToPath(new URL('../../../client/src/assets/logos/uconsulting-alternate.svg', import.meta.url)),
    'utf8'
  );
} catch (e) {
  // The logo asset may not be available in all deployment layouts; fall back to a text logo.
  LOGO_SVG = null;
}

export const DEFAULT_TEMPLATE = {
  introText:
    `Congratulations! Our team is beyond excited to extend you an offer for a position in UConsulting's (UC) {{cycleName}} Intern class. This quarter's recruitment cycle was extremely competitive. Through this process, we have determined that the combination of your business acumen, professional ambition, and unique personal qualities make you an exceptional candidate to join our UC Family.

` +
    `UConsulting is composed of some of UCLA's brightest minds and most successful current students and alumni. From holding positions at elite consulting firms such as McKinsey, BCG, Bain, EY-Parthenon, Deloitte Consulting, LEK, and others, to attending Stanford Business School and beyond — the UC Family provides the resources and mentorship to guide you in your professional journey.

` +
    `Along with the extensive community and network that UConsulting offers its members, you will have the opportunity to train, develop, and perfect your business skills through our Accelerator Program, consulting projects, and professional workshops. We, at UC, also believe it is our mission to build, support, and guide the UCLA campus community through the competitive business landscape and hope you will play an integral role in carrying out this goal.`,
  terms: [
    'Attend all Accelerator Program workshops and events',
    'Complete ~3 coffee chats with current/new members per week throughout the quarter',
    'Participate on a client project during the upcoming quarter and at least one more during your time in UC'
  ],
  closingText:
    'If you choose to accept, please return a signed PDF copy to uconsultingla@gmail.com by {{responseDeadline}}.',
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
  confidentialityLabel: 'STRICTLY CONFIDENTIAL'
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
  // Normalize all signatures to PNG so pdfmake can embed them reliably.
  const pngBuffer = await sharp(buffer).png().toBuffer();
  const path = signaturePath(cycleId, '.png');
  await ensureBucket(SIGNATURE_BUCKET, false);
  const { error } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .upload(path, pngBuffer, { contentType: 'image/png', upsert: true });
  if (error) throw error;
  return { path, contentType: 'image/png' };
}

export async function getSignatureBuffer(signaturePath) {
  if (!signaturePath || !isSupabaseAvailable()) return null;
  try {
    const { data, error } = await supabase.storage.from(SIGNATURE_BUCKET).download(signaturePath);
    if (error || !data) return null;
    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    // Convert to PNG for reliable embedding in pdfmake-generated PDFs.
    return await sharp(buffer).png().toBuffer();
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

const HEADER_BLUE = '#042742';
const RED = '#d32f2f';
const BLUE = '#0c74c1';

function getLogoSvg() {
  if (LOGO_SVG) {
    return { svg: LOGO_SVG, fit: [70, 70] };
  }
  return { text: 'UC', color: '#ffffff', bold: true, fontSize: 28 };
}

function formatLetterDate(date = new Date()) {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const d = new Date(date);
  const day = d.getDate();
  let suffix = 'th';
  if (day === 1 || day === 21 || day === 31) suffix = 'st';
  else if (day === 2 || day === 22) suffix = 'nd';
  else if (day === 3 || day === 23) suffix = 'rd';
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

function colorUConsulting(text) {
  const parts = [];
  const marker = 'UConsulting';
  let remaining = String(text || '');
  let idx;
  while ((idx = remaining.indexOf(marker)) !== -1) {
    if (idx > 0) parts.push({ text: remaining.substring(0, idx) });
    parts.push({ text: marker, color: BLUE, bold: true });
    remaining = remaining.substring(idx + marker.length);
  }
  if (remaining.length) parts.push({ text: remaining });
  return parts.length ? parts : [{ text: text }];
}

function styleDeadlineText(text, deadline) {
  if (!deadline || !text) return [{ text: text || '' }];
  const idx = text.indexOf(deadline);
  if (idx === -1) return [{ text }];
  return [
    { text: text.substring(0, idx) },
    { text: deadline, color: RED, bold: true },
    { text: text.substring(idx + deadline.length) }
  ];
}

export async function generateOfferLetterPdf(application, cycle, template, offerDetails, signatureBuffer) {
  const candidateName = `${application.firstName} ${application.lastName}`;
  const responseDeadline = offerDetails.responseDeadline || template.responseDeadline || 'the deadline specified by the recruitment team';
  const cycleName = cycle?.name || 'UConsulting';
  const position = offerDetails.position || 'Associate';
  const startDate = offerDetails.startDate || 'To be determined';

  const values = {
    candidateName,
    position,
    cycleName,
    startDate,
    responseDeadline
  };

  const introText = substitutePlaceholders(template.introText || DEFAULT_TEMPLATE.introText, values);
  const closingText = substitutePlaceholders(template.closingText || DEFAULT_TEMPLATE.closingText, values);
  const terms = (template.terms || DEFAULT_TEMPLATE.terms).map((t) => substitutePlaceholders(t, values));
  const checklist = (template.checklist || DEFAULT_TEMPLATE.checklist).map((t) => substitutePlaceholders(t, values));

  const introParagraphs = introText.split('\n\n').filter(Boolean);
  const closingParagraphs = closingText.split('\n\n').filter(Boolean);

  const letterDate = formatLetterDate();
  const officialOfferLabel = template.officialOfferLabel || DEFAULT_TEMPLATE.officialOfferLabel;
  const confidentialityLabel = template.confidentialityLabel || DEFAULT_TEMPLATE.confidentialityLabel;
  const printedNameLabel = template.printedNameLabel || DEFAULT_TEMPLATE.printedNameLabel;
  const signatureLabel = template.signatureLabel || DEFAULT_TEMPLATE.signatureLabel;
  const presidentName = template.presidentName || DEFAULT_TEMPLATE.presidentName;
  const presidentTitle = template.presidentTitle || DEFAULT_TEMPLATE.presidentTitle;

  const bodyContent = [];

  bodyContent.push({ text: `Dear ${candidateName},`, margin: [0, 10, 0, 10] });

  for (const p of introParagraphs) {
    bodyContent.push({ text: p, margin: [0, 0, 0, 10], lineHeight: 1.4 });
  }

  bodyContent.push({
    text: 'As a new member, your expectations are as follows:',
    margin: [0, 10, 0, 6],
    bold: true
  });
  bodyContent.push({
    ul: terms,
    margin: [20, 0, 0, 10]
  });

  for (const p of closingParagraphs) {
    bodyContent.push({
      text: styleDeadlineText(p, responseDeadline),
      margin: [0, 0, 0, 14],
      lineHeight: 1.4
    });
  }

  bodyContent.push({
    text: 'Please check the boxes and sign below:',
    margin: [0, 10, 0, 6],
    bold: true
  });

  const checklistRows = checklist.map((item) => [
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, lineWidth: 1 }], margin: [0, 2, 0, 0], width: 20 },
    { text: item, margin: [0, 0, 0, 8] }
  ]);
  bodyContent.push({
    table: {
      widths: [20, '*'],
      body: checklistRows
    },
    layout: 'noBorders',
    margin: [0, 0, 0, 10]
  });

  const rightStack = [];
  if (signatureBuffer) {
    const signatureDataUri = `data:image/png;base64,${signatureBuffer.toString('base64')}`;
    rightStack.push({ image: signatureDataUri, fit: [150, 60], alignment: 'left' });
  }
  rightStack.push({
    text: presidentName,
    bold: true,
    margin: [0, signatureBuffer ? 4 : 0, 0, 2]
  });
  rightStack.push({ text: colorUConsulting(presidentTitle) });

  bodyContent.push({
    margin: [0, 10, 0, 0],
    table: {
      widths: ['45%', '55%'],
      body: [
        [
          {
            stack: [
              { text: printedNameLabel, bold: true, fontSize: 10 },
              { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 170, y2: 0, lineWidth: 1 }], margin: [0, 8, 0, 0] }
            ],
            margin: [0, 0, 10, 0]
          },
          { stack: rightStack, alignment: 'left' }
        ],
        [
          {
            stack: [
              { text: signatureLabel, bold: true, fontSize: 10 },
              { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 170, y2: 0, lineWidth: 1 }], margin: [0, 8, 0, 0] }
            ]
          },
          { text: '' }
        ]
      ]
    },
    layout: 'noBorders'
  });

  const docDefinition = {
    pageSize: 'LETTER',
    pageMargins: [0, 100, 0, 60],
    defaultStyle: {
      font: 'Helvetica',
      fontSize: 11,
      color: '#222'
    },
    background: function (page, pageSize) {
      return [
        { canvas: [{ type: 'rect', x: 0, y: 0, w: pageSize.width, h: 100, color: HEADER_BLUE }] },
        { canvas: [{ type: 'rect', x: 0, y: pageSize.height - 60, w: pageSize.width, h: 60, color: HEADER_BLUE }] }
      ];
    },
    header: function () {
      return {
        margin: [40, 20, 40, 0],
        columns: [
          {
            width: '*',
            stack: [
              { text: officialOfferLabel, color: '#ffffff', bold: true, fontSize: 16 },
              { text: letterDate, color: '#ffffff', fontSize: 11, margin: [0, 4, 0, 0] }
            ]
          },
          { width: 'auto', ...getLogoSvg() }
        ]
      };
    },
    footer: function () {
      return {
        margin: [40, 14, 40, 0],
        columns: [
          { width: '*', text: confidentialityLabel, color: '#ffffff', bold: true, fontSize: 10 },
          { width: 'auto', text: 'UC', color: '#ffffff', bold: true, fontSize: 24 }
        ]
      };
    },
    content: [
      { stack: bodyContent, margin: [40, 0, 40, 0] }
    ]
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
