import pdfmake from 'pdfmake';
import supabase, { isSupabaseAvailable } from '../supabaseClient.js';

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

export const DEFAULT_TEMPLATE = {
  introText:
    "Congratulations! Our team is beyond excited to extend you an offer for a position in UConsulting's (UC) {{cycleName}} Intern class. This quarter's recruitment cycle was extremely competitive. Through this process, we have determined that the combination of your business acumen, professional ambition, and unique personal qualities make you an exceptional candidate to join our UC Family.\n\n" +
    "UConsulting is composed of some of UCLA's brightest minds and most successful current students and alumni. From holding positions at elite consulting firms such as McKinsey, BCG, Bain, EY-Parthenon, Deloitte Consulting, LEK, and others, to attending Stanford Business School and beyond — the UC Family provides the resources and mentorship to guide you in your professional journey.\n\n" +
    "Along with the extensive community and network that UConsulting offers its members, you will have the opportunity to train, develop, and perfect your business skills through our Accelerator Program, consulting projects, and professional workshops. We, at UC, also believe it is our mission to build, support, and guide the UCLA campus community through the competitive business landscape and hope you will play an integral role in carrying out this goal.",
  terms: [
    'Attend all Accelerator Program workshops and events',
    'Complete ~3 coffee chats with current/new members per week throughout the quarter',
    'Participate on a client project during Spring 2026 and at least one more during your time in UC'
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

function templatePath(cycleId) {
  return `${cycleId}.json`;
}

function signaturePath(cycleId, ext) {
  return `${cycleId}/signature${ext}`;
}

async function ensureBucket(name, isPublic = true) {
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
  await ensureBucket(TEMPLATE_BUCKET, true);
  try {
    const { data, error } = await supabase.storage
      .from(TEMPLATE_BUCKET)
      .download(templatePath(cycleId));
    if (error || !data) {
      if (error?.message?.includes('not found') || error?.message?.includes('Not found')) {
        return JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
      }
      console.warn('[getOfferLetterTemplate] download error:', error?.message);
      return JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
    }
    const text = await data.text();
    return { ...DEFAULT_TEMPLATE, ...JSON.parse(text) };
  } catch (e) {
    console.warn('[getOfferLetterTemplate] parse error:', e.message);
    return JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
  }
}

export async function saveOfferLetterTemplate(cycleId, template) {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase storage is not configured');
  }
  await ensureBucket(TEMPLATE_BUCKET, true);
  const payload = JSON.stringify(template, null, 2);
  const { error } = await supabase.storage
    .from(TEMPLATE_BUCKET)
    .upload(templatePath(cycleId), Buffer.from(payload), {
      contentType: 'application/json',
      upsert: true
    });
  if (error) throw error;
  return template;
}

export async function uploadSignature(cycleId, buffer, contentType) {
  if (!isSupabaseAvailable()) {
    throw new Error('Supabase storage is not configured');
  }
  const ext = contentType === 'image/jpeg' ? '.jpg' : contentType === 'image/webp' ? '.webp' : '.png';
  const path = signaturePath(cycleId, ext);
  await ensureBucket(SIGNATURE_BUCKET, true);
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

export async function getSignatureBufferForCycle(cycleId) {
  if (!isSupabaseAvailable()) return null;
  // Try common extensions for this cycle.
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const buffer = await getSignatureBuffer(signaturePath(cycleId, ext));
    if (buffer) return { buffer, contentType: extToContentType(ext) };
  }
  return null;
}

function extToContentType(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

export function getSignaturePublicUrl(signaturePath) {
  if (!signaturePath || !isSupabaseAvailable()) return null;
  const { data } = supabase.storage.from(SIGNATURE_BUCKET).getPublicUrl(signaturePath);
  return data?.publicUrl || null;
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
  // Simple magic number checks for common image formats
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg';
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  }
  return 'image/png';
}
