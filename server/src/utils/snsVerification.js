import crypto from 'crypto';

const SIGNING_CERT_CACHE = new Map();
const SIGNING_CERT_TIMEOUT_MS = 5000;

export function clearSigningCertCache() {
  SIGNING_CERT_CACHE.clear();
}

export function isValidSnsSigningCertUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (!/^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname)) return false;
    if (!parsed.pathname.endsWith('.pem')) return false;
    return true;
  } catch {
    return false;
  }
}

export function buildSnsStringToSign(payload) {
  const type = payload.Type;
  const parts = [];

  if (type === 'Notification') {
    parts.push(['Message', payload.Message]);
    parts.push(['MessageId', payload.MessageId]);
    if (payload.Subject !== undefined) {
      parts.push(['Subject', payload.Subject]);
    }
    parts.push(['Timestamp', payload.Timestamp]);
    parts.push(['TopicArn', payload.TopicArn]);
    parts.push(['Type', payload.Type]);
  } else if (type === 'SubscriptionConfirmation' || type === 'UnsubscribeConfirmation') {
    const urlKey = type === 'SubscriptionConfirmation' ? 'SubscribeURL' : 'UnsubscribeURL';
    parts.push(['Message', payload.Message]);
    parts.push(['MessageId', payload.MessageId]);
    parts.push([urlKey, payload[urlKey]]);
    parts.push(['Timestamp', payload.Timestamp]);
    parts.push(['Token', payload.Token]);
    parts.push(['TopicArn', payload.TopicArn]);
    parts.push(['Type', payload.Type]);
  } else {
    throw new Error(`Unsupported SNS message type: ${type}`);
  }

  return parts.map(([key, value]) => `${key}\n${value}`).join('\n');
}

function validateCertificate(pem, options = {}) {
  if (options.verifyCertificate === false) return;

  let cert;
  try {
    cert = new crypto.X509Certificate(pem);
  } catch (error) {
    throw new Error(`Invalid SNS signing certificate: ${error.message}`);
  }

  const subject = cert.subject.toLowerCase();
  const issuer = cert.issuer.toLowerCase();
  const subjectOk = subject.includes('amazon') || subject.includes('sns') || subject.includes('simplenotificationservice');
  const issuerOk = issuer.includes('amazon') || issuer.includes('digicert') || issuer.includes('symantec');

  if (!subjectOk || !issuerOk) {
    throw new Error('SNS signing certificate does not appear to be issued by Amazon SNS');
  }
}

export async function fetchSnsSigningCert(url, options = {}) {
  if (!isValidSnsSigningCertUrl(url)) {
    throw new Error(`Untrusted SNS signing certificate URL: ${url}`);
  }

  const cached = SIGNING_CERT_CACHE.get(url);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIGNING_CERT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch SNS signing certificate: ${response.status} ${response.statusText}`);
  }

  const pem = await response.text();
  validateCertificate(pem, options);
  SIGNING_CERT_CACHE.set(url, pem);
  return pem;
}

export function getSnsSignatureAlgorithm(signatureVersion) {
  if (signatureVersion === '1') return 'RSA-SHA1';
  if (signatureVersion === '2') return 'RSA-SHA256';
  throw new Error(`Unsupported SNS SignatureVersion: ${signatureVersion}`);
}

export async function verifySnsSignature(payload, options = {}) {
  const {
    requiredTopicArn,
    verifyCertificate = true,
    getSigningCert = fetchSnsSigningCert,
    now = Date.now(),
    maxTimestampAgeMs = 15 * 60 * 1000,
  } = options;

  if (!payload || typeof payload !== 'object') {
    throw new Error('SNS payload is required');
  }

  if (!['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation'].includes(payload.Type)) {
    throw new Error(`Unsupported SNS message type: ${payload.Type}`);
  }

  if (requiredTopicArn && payload.TopicArn !== requiredTopicArn) {
    throw new Error(`SNS topic mismatch: expected ${requiredTopicArn}, got ${payload.TopicArn}`);
  }

  if (maxTimestampAgeMs && payload.Timestamp) {
    const ts = new Date(payload.Timestamp).getTime();
    if (Number.isNaN(ts) || now - ts > maxTimestampAgeMs) {
      throw new Error('SNS message timestamp is too old or invalid');
    }
  }

  if (!isValidSnsSigningCertUrl(payload.SigningCertURL)) {
    throw new Error(`Untrusted SNS signing certificate URL: ${payload.SigningCertURL}`);
  }

  const algorithm = getSnsSignatureAlgorithm(payload.SignatureVersion);
  const stringToSign = buildSnsStringToSign(payload);
  const pem = await getSigningCert(payload.SigningCertURL, { verifyCertificate });

  let publicKey;
  try {
    publicKey = crypto.createPublicKey(pem);
  } catch (error) {
    throw new Error(`Unable to create public key from SNS signing certificate: ${error.message}`);
  }

  const isValid = crypto.verify(
    algorithm,
    Buffer.from(stringToSign, 'utf8'),
    publicKey,
    Buffer.from(payload.Signature, 'base64')
  );

  if (!isValid) {
    throw new Error('SNS signature verification failed');
  }

  return true;
}
