import { Resolver } from 'node:dns/promises';
import {
  SESv2Client,
  GetAccountCommand,
  GetEmailIdentityCommand,
  GetConfigurationSetEventDestinationsCommand,
} from '@aws-sdk/client-sesv2';
import prisma from '../prismaClient.js';

// Is our mail getting through, and if not, why?
//
// Answers from four places, each checked on its own so one failing does not
// hide the rest:
//   - the environment this server sends with (sendEmail in emailNotifications.js)
//   - Amazon SES itself: account standing, the sending identity, and whether the
//     configuration set actually reports back to /api/webhooks/ses
//   - public DNS for the From domain, which is what receiving servers read
//   - communication_logs, where SES's delivery/bounce/complaint events land
//     (services/sesEvents.js)
//
// Every check answers one of four statuses. UNKNOWN is not a failure: it is what
// a check says when it could not look (no permission, no network), so the page
// never claims something is broken that it simply could not see.

export const STATUS = { OK: 'ok', WARN: 'warn', FAIL: 'fail', UNKNOWN: 'unknown', INFO: 'info' };

const SEVERITY = { ok: 0, info: 0, unknown: 1, warn: 2, fail: 3 };

export function worstStatus(statuses) {
  let worst = STATUS.OK;
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

const check = (key, label, status, detail, extra = {}) => ({ key, label, status, detail, ...extra });

// "UConsulting <noreply@uc.org>" or a bare address -> the address.
export function parseFromAddress(value) {
  if (!value) return null;
  const match = /<([^>]+)>/.exec(value);
  const address = (match ? match[1] : value).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) ? address : null;
}

export const domainOf = (address) => (address ? address.split('@')[1] : null);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export function configurationChecks(env = process.env) {
  const from = parseFromAddress(env.EMAIL_FROM);
  const checks = [];

  checks.push(
    from
      ? check('from', 'From address', STATUS.OK, from)
      : check('from', 'From address', STATUS.FAIL, 'EMAIL_FROM is unset or not an address; every send will be refused.')
  );

  checks.push(
    env.EMAIL_REPLY_TO
      ? check('replyTo', 'Reply-To address', STATUS.OK, env.EMAIL_REPLY_TO)
      : check('replyTo', 'Reply-To address', STATUS.WARN, 'EMAIL_REPLY_TO is unset, so replies go to the From address.')
  );

  checks.push(
    env.AWS_REGION
      ? check('region', 'SES region', STATUS.OK, env.AWS_REGION)
      : check('region', 'SES region', STATUS.FAIL, 'AWS_REGION is unset; the SES client cannot pick an endpoint.')
  );

  const hasKeys = Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
  checks.push(
    hasKeys
      ? check('credentials', 'AWS credentials', STATUS.OK, 'Access key is set.')
      : check(
          'credentials',
          'AWS credentials',
          STATUS.WARN,
          'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set. That is fine only if the host provides an IAM role.'
        )
  );

  checks.push(
    env.SES_CONFIGURATION_SET
      ? check('configSet', 'Configuration set', STATUS.OK, env.SES_CONFIGURATION_SET)
      : check(
          'configSet',
          'Configuration set',
          STATUS.WARN,
          'SES_CONFIGURATION_SET is unset, so SES never reports deliveries, bounces or complaints and every email stays "Sent".'
        )
  );

  checks.push(
    env.SES_SNS_TOPIC_ARN
      ? check('snsTopic', 'Event webhook topic', STATUS.OK, env.SES_SNS_TOPIC_ARN)
      : check(
          'snsTopic',
          'Event webhook topic',
          STATUS.WARN,
          'SES_SNS_TOPIC_ARN is unset, so /api/webhooks/ses refuses every event.'
        )
  );

  checks.push(
    env.UNSUBSCRIBE_SECRET
      ? check('unsubscribeSecret', 'Unsubscribe link secret', STATUS.OK, 'Set.')
      : check(
          'unsubscribeSecret',
          'Unsubscribe link secret',
          STATUS.INFO,
          'UNSUBSCRIBE_SECRET is unset; unsubscribe links are signed with JWT_SECRET instead.'
        )
  );

  return checks;
}

// ---------------------------------------------------------------------------
// Amazon SES
// ---------------------------------------------------------------------------

// An IAM user made only to send has no read permissions, and that is a
// reasonable way to run. Say what is missing instead of calling it broken.
function awsFailure(key, label, error, permission) {
  const denied = error?.name === 'AccessDeniedException' || error?.$metadata?.httpStatusCode === 403;
  if (denied) {
    return check(key, label, STATUS.UNKNOWN, `Could not check: the sending IAM user lacks ${permission}.`);
  }
  if (error?.name === 'NotFoundException') {
    return check(key, label, STATUS.FAIL, 'Not found in this SES region.');
  }
  return check(key, label, STATUS.UNKNOWN, `Could not check: ${error?.message || 'SES did not answer'}.`);
}

export function interpretAccount(account) {
  const checks = [];

  checks.push(
    account.SendingEnabled === false
      ? check('sending', 'Sending enabled', STATUS.FAIL, 'SES has paused sending for this account.')
      : check('sending', 'Sending enabled', STATUS.OK, 'SES is accepting mail from this account.')
  );

  checks.push(
    account.ProductionAccessEnabled
      ? check('production', 'Production access', STATUS.OK, 'Out of the SES sandbox.')
      : check(
          'production',
          'Production access',
          STATUS.FAIL,
          'The account is in the SES sandbox: it can only send to verified addresses, so candidates get nothing.'
        )
  );

  const enforcement = account.EnforcementStatus || 'UNKNOWN';
  const enforcementStatus =
    enforcement === 'HEALTHY' ? STATUS.OK : enforcement === 'PROBATION' ? STATUS.WARN : enforcement === 'SHUTDOWN' ? STATUS.FAIL : STATUS.UNKNOWN;
  const enforcementDetail = {
    HEALTHY: 'AWS reports the account in good standing.',
    PROBATION: 'AWS put the account on probation, usually for bounce or complaint rates. Fix the cause before it is shut down.',
    SHUTDOWN: 'AWS shut the account down. Nothing will send until AWS reinstates it.',
  }[enforcement] || `AWS reports "${enforcement}".`;
  checks.push(check('enforcement', 'Account standing', enforcementStatus, enforcementDetail));

  const quota = account.SendQuota;
  if (quota && quota.Max24HourSend > 0) {
    const used = quota.SentLast24Hours / quota.Max24HourSend;
    const status = used >= 0.9 ? STATUS.FAIL : used >= 0.7 ? STATUS.WARN : STATUS.OK;
    checks.push(
      check(
        'quota',
        'Daily quota',
        status,
        `${Math.round(quota.SentLast24Hours)} of ${Math.round(quota.Max24HourSend)} sent in the last 24 hours, up to ${quota.MaxSendRate}/second.`,
        { used: quota.SentLast24Hours, max: quota.Max24HourSend, rate: quota.MaxSendRate }
      )
    );
  }

  return checks;
}

export function interpretIdentity(identity, name) {
  const checks = [];

  checks.push(
    identity.VerifiedForSendingStatus
      ? check('identity', 'Sending identity', STATUS.OK, `${name} is verified in SES.`)
      : check('identity', 'Sending identity', STATUS.FAIL, `${name} is not verified in SES, so SES refuses mail from it.`)
  );

  const dkim = identity.DkimAttributes?.Status;
  const dkimStatus = dkim === 'SUCCESS' ? STATUS.OK : dkim === 'PENDING' ? STATUS.WARN : STATUS.FAIL;
  const dkimDetail = {
    SUCCESS: 'Mail is DKIM-signed and the DNS records check out.',
    PENDING: 'SES is still waiting to see the DKIM records in DNS.',
    FAILED: 'SES could not find the DKIM records in DNS. Gmail and Yahoo reject or spam unsigned bulk mail.',
    TEMPORARY_FAILURE: 'SES could not read the DKIM records just now; it will retry.',
    NOT_STARTED: 'DKIM has not been set up for this identity.',
  }[dkim] || 'DKIM is not set up for this identity.';
  checks.push(check('dkim', 'DKIM signing', dkimStatus, dkimDetail));

  const mailFrom = identity.MailFromAttributes;
  if (mailFrom?.MailFromDomain) {
    const ok = mailFrom.MailFromDomainStatus === 'SUCCESS';
    checks.push(
      check(
        'mailFrom',
        'Custom MAIL FROM',
        ok ? STATUS.OK : STATUS.WARN,
        ok
          ? `${mailFrom.MailFromDomain} is set up, so SPF aligns with the From domain.`
          : `${mailFrom.MailFromDomain} is ${String(mailFrom.MailFromDomainStatus || 'not verified').toLowerCase()}; SES falls back to amazonses.com.`
      )
    );
  } else {
    checks.push(
      check(
        'mailFrom',
        'Custom MAIL FROM',
        STATUS.INFO,
        'Not set, so the envelope sender is amazonses.com. DMARC still passes through DKIM.'
      )
    );
  }

  return checks;
}

// The configuration set is only worth having if it points at the topic the
// webhook trusts and sends the events the log uses.
const NEEDED_EVENTS = ['DELIVERY', 'BOUNCE', 'COMPLAINT'];

export function interpretEventDestinations(destinations, topicArn) {
  const sns = (destinations || []).filter((d) => d.SnsDestination?.TopicArn);
  if (sns.length === 0) {
    return check('eventDestination', 'Event destination', STATUS.FAIL, 'The configuration set has no SNS destination, so no events reach the ATS.');
  }
  const ours = topicArn ? sns.find((d) => d.SnsDestination.TopicArn === topicArn) : null;
  if (!ours) {
    return check(
      'eventDestination',
      'Event destination',
      STATUS.FAIL,
      `The configuration set publishes to ${sns.map((d) => d.SnsDestination.TopicArn).join(', ')}, not the topic the webhook accepts${topicArn ? ` (${topicArn})` : ''}.`
    );
  }
  if (ours.Enabled === false) {
    return check('eventDestination', 'Event destination', STATUS.FAIL, `"${ours.Name}" is disabled.`);
  }
  const types = ours.MatchingEventTypes || [];
  const missing = NEEDED_EVENTS.filter((t) => !types.includes(t));
  if (missing.length) {
    return check(
      'eventDestination',
      'Event destination',
      STATUS.WARN,
      `"${ours.Name}" does not publish ${missing.map((t) => t.toLowerCase()).join(', ')} events.`
    );
  }
  return check('eventDestination', 'Event destination', STATUS.OK, `"${ours.Name}" publishes deliveries, bounces and complaints to the webhook.`);
}

let defaultClient;
const sesClient = () => (defaultClient ??= new SESv2Client({ region: process.env.AWS_REGION }));

export async function sesChecks({ env = process.env, client } = {}) {
  if (!env.AWS_REGION) return [];
  const ses = client || sesClient();
  const from = parseFromAddress(env.EMAIL_FROM);
  const domain = domainOf(from);
  const checks = [];

  const [account, identity, destinations] = await Promise.allSettled([
    ses.send(new GetAccountCommand({})),
    domain ? getIdentity(ses, domain, from) : Promise.resolve(null),
    env.SES_CONFIGURATION_SET
      ? ses.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: env.SES_CONFIGURATION_SET }))
      : Promise.resolve(null),
  ]);

  if (account.status === 'fulfilled') checks.push(...interpretAccount(account.value));
  else checks.push(awsFailure('account', 'SES account', account.reason, 'ses:GetAccount'));

  if (identity.status === 'fulfilled' && identity.value) {
    checks.push(...interpretIdentity(identity.value.identity, identity.value.name));
  } else if (identity.status === 'rejected') {
    checks.push(awsFailure('identity', 'Sending identity', identity.reason, 'ses:GetEmailIdentity'));
  }

  if (destinations.status === 'fulfilled' && destinations.value) {
    checks.push(interpretEventDestinations(destinations.value.EventDestinations, env.SES_SNS_TOPIC_ARN));
  } else if (destinations.status === 'rejected') {
    checks.push(awsFailure('eventDestination', 'Event destination', destinations.reason, 'ses:GetConfigurationSetEventDestinations'));
  }

  return checks;
}

// SES matches a From address against a verified address first, then its domain.
// Either is a valid setup, so a domain that is not an identity falls through to
// the address.
async function getIdentity(ses, domain, address) {
  try {
    return { name: domain, identity: await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain })) };
  } catch (error) {
    if (error?.name !== 'NotFoundException') throw error;
    return { name: address, identity: await ses.send(new GetEmailIdentityCommand({ EmailIdentity: address })) };
  }
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

const txtRecords = async (resolver, name) => {
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (error) {
    if (error?.code === 'ENODATA' || error?.code === 'ENOTFOUND') return [];
    throw error;
  }
};

export function interpretSpf(records) {
  const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) {
    // SES mail is SPF-checked against its envelope sender - amazonses.com, or a
    // custom MAIL FROM subdomain with its own record - never the bare From
    // domain. A record here only stops other people spoofing the domain.
    return check(
      'spf',
      'SPF record',
      STATUS.INFO,
      'None on the From domain. SES mail passes SPF through its envelope sender, so this only matters for stopping spoofing.'
    );
  }
  if (spf.length > 1) {
    return check('spf', 'SPF record', STATUS.FAIL, 'More than one SPF record: receivers treat that as an error and ignore both.', { records: spf });
  }
  const record = spf[0];
  if (/\s\+all\b/i.test(record)) {
    return check('spf', 'SPF record', STATUS.FAIL, 'The SPF record ends in +all, which lets anyone send as this domain.', { records: spf });
  }
  return check('spf', 'SPF record', STATUS.OK, record, { records: spf });
}

export function interpretDmarc(records) {
  const dmarc = records.filter((r) => /^v=DMARC1/i.test(r.trim()));
  if (dmarc.length === 0) {
    return check(
      'dmarc',
      'DMARC policy',
      STATUS.WARN,
      'No DMARC record. Gmail and Yahoo require one from anyone sending in bulk, and mail without it is more likely to land in spam.'
    );
  }
  if (dmarc.length > 1) {
    return check('dmarc', 'DMARC policy', STATUS.FAIL, 'More than one DMARC record: receivers ignore both.', { records: dmarc });
  }
  const policy = /(?:^|;)\s*p\s*=\s*(\w+)/i.exec(dmarc[0])?.[1]?.toLowerCase();
  if (!policy) {
    return check('dmarc', 'DMARC policy', STATUS.FAIL, 'The DMARC record has no p= policy, so it is invalid.', { records: dmarc });
  }
  const note = policy === 'none' ? ' Monitoring only; that meets the bulk-sender rules.' : '';
  return check('dmarc', 'DMARC policy', STATUS.OK, `p=${policy}.${note}`, { records: dmarc });
}

export async function dnsChecks({ env = process.env, resolver } = {}) {
  const domain = domainOf(parseFromAddress(env.EMAIL_FROM));
  if (!domain) return [];
  const dns = resolver || new Resolver({ timeout: 4000, tries: 2 });

  const [spf, dmarc, mx] = await Promise.allSettled([
    txtRecords(dns, domain),
    txtRecords(dns, `_dmarc.${domain}`),
    dns.resolveMx(domain),
  ]);

  const checks = [];
  checks.push(
    spf.status === 'fulfilled'
      ? interpretSpf(spf.value)
      : check('spf', 'SPF record', STATUS.UNKNOWN, `Could not look up DNS: ${spf.reason?.code || spf.reason?.message}.`)
  );
  checks.push(
    dmarc.status === 'fulfilled'
      ? interpretDmarc(dmarc.value)
      : check('dmarc', 'DMARC policy', STATUS.UNKNOWN, `Could not look up DNS: ${dmarc.reason?.code || dmarc.reason?.message}.`)
  );

  if (mx.status === 'fulfilled' && mx.value.length > 0) {
    const hosts = [...mx.value].sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    checks.push(check('mx', 'Inbound mail (MX)', STATUS.OK, hosts.join(', ')));
  } else if (mx.status === 'fulfilled' || ['ENODATA', 'ENOTFOUND'].includes(mx.reason?.code)) {
    // Bounces go to SES's envelope sender, not here, so the only mail lost is
    // replies - and only if they are addressed to this domain.
    const replyDomain = domainOf(parseFromAddress(env.EMAIL_REPLY_TO)) || domain;
    checks.push(
      replyDomain === domain
        ? check('mx', 'Inbound mail (MX)', STATUS.WARN, `${domain} accepts no mail, and replies go to it, so they are lost.`)
        : check('mx', 'Inbound mail (MX)', STATUS.INFO, `${domain} accepts no mail. Replies go to ${replyDomain}, so nothing is lost.`)
    );
  } else {
    checks.push(check('mx', 'Inbound mail (MX)', STATUS.UNKNOWN, `Could not look up DNS: ${mx.reason?.code || mx.reason?.message}.`));
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Delivery, from communication_logs
// ---------------------------------------------------------------------------

// SES reviews an account at a 5% bounce rate and 0.1% complaint rate; Gmail
// starts filtering above 0.3% spam. The warnings sit well under those so there
// is time to act.
export const THRESHOLDS = {
  bounce: { warn: 0.02, fail: 0.05 },
  complaint: { warn: 0.0005, fail: 0.001 },
};

// Below this many sends one bounce is 10%, which says nothing about reputation.
export const MIN_SAMPLE = 50;

// An email's delivery event usually arrives within a minute. After an hour one
// still at SENT is one SES never reported on.
const FEEDBACK_GRACE_MS = 60 * 60 * 1000;

function grade(rate, { warn, fail }) {
  if (rate >= fail) return STATUS.FAIL;
  if (rate >= warn) return STATUS.WARN;
  return STATUS.OK;
}

const pct = (rate) => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

export function summarizeDelivery(counts, { awaitingFeedback = 0, eligibleForFeedback = 0, feedbackConfigured = true } = {}) {
  const n = (s) => counts[s] || 0;
  // FAILED never left the server, so it is not part of what SES rates us on.
  const attempted = n('SENT') + n('DELIVERED') + n('DELAYED') + n('BOUNCED') + n('COMPLAINED');
  const bounceRate = attempted ? n('BOUNCED') / attempted : 0;
  const complaintRate = attempted ? n('COMPLAINED') / attempted : 0;
  const enough = attempted >= MIN_SAMPLE;
  const checks = [];

  const small = ` Only ${attempted} sent, too few to judge.`;
  checks.push(
    check(
      'bounceRate',
      'Bounce rate',
      enough ? grade(bounceRate, THRESHOLDS.bounce) : STATUS.INFO,
      `${pct(bounceRate)} (${n('BOUNCED')} of ${attempted}). SES reviews accounts at 5%.${enough ? '' : small}`,
      { rate: bounceRate }
    )
  );
  checks.push(
    check(
      'complaintRate',
      'Spam complaint rate',
      enough ? grade(complaintRate, THRESHOLDS.complaint) : STATUS.INFO,
      `${pct(complaintRate)} (${n('COMPLAINED')} of ${attempted}). SES reviews accounts at 0.1%.${enough ? '' : small}`,
      { rate: complaintRate }
    )
  );

  const failed = n('FAILED');
  const failTotal = attempted + failed;
  const failRate = failTotal ? failed / failTotal : 0;
  checks.push(
    check(
      'sendFailures',
      'Send failures',
      failed === 0 ? STATUS.OK : failRate >= 0.05 ? STATUS.FAIL : STATUS.WARN,
      failed === 0 ? 'SES accepted every message.' : `${failed} message${failed === 1 ? '' : 's'} never left: SES refused them or could not be reached.`
    )
  );

  if (!feedbackConfigured) {
    checks.push(
      check(
        'feedback',
        'Delivery reports arriving',
        STATUS.INFO,
        'Not configured, so there is no way to tell delivered mail from mail that vanished.'
      )
    );
  } else if (eligibleForFeedback === 0) {
    checks.push(check('feedback', 'Delivery reports arriving', STATUS.INFO, 'Nothing sent over an hour ago in this window yet.'));
  } else {
    const share = awaitingFeedback / eligibleForFeedback;
    const status = share > 0.5 && awaitingFeedback >= 5 ? STATUS.FAIL : share > 0.1 ? STATUS.WARN : STATUS.OK;
    checks.push(
      check(
        'feedback',
        'Delivery reports arriving',
        status,
        status === STATUS.OK
          ? 'SES is reporting back on sent mail.'
          : `${awaitingFeedback} of ${eligibleForFeedback} emails sent over an hour ago never heard back from SES. Check the SNS subscription to /api/webhooks/ses.`
      )
    );
  }

  return {
    totals: {
      attempted,
      delivered: n('DELIVERED'),
      delayed: n('DELAYED'),
      bounced: n('BOUNCED'),
      complained: n('COMPLAINED'),
      failed,
      awaiting: n('SENT'),
    },
    checks,
  };
}

const PROBLEM_STATUSES = ['BOUNCED', 'COMPLAINED', 'FAILED', 'DELAYED'];

export async function deliveryReport({ days = 7, env = process.env, now = new Date(), client = prisma } = {}) {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const graceCutoff = new Date(now.getTime() - FEEDBACK_GRACE_MS);
  const base = { channel: 'email', sentAt: { gte: since } };
  const olderThanGrace = { channel: 'email', sentAt: { gte: since, lt: graceCutoff } };

  const [grouped, awaitingFeedback, eligibleForFeedback, problems, lastDelivered, suppressions] = await Promise.all([
    client.communicationLog.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    client.communicationLog.count({ where: { ...olderThanGrace, status: 'SENT' } }),
    client.communicationLog.count({ where: { ...olderThanGrace, status: { not: 'FAILED' } } }),
    client.communicationLog.findMany({
      where: { ...base, status: { in: PROBLEM_STATUSES } },
      orderBy: { sentAt: 'desc' },
      take: 25,
      select: { id: true, recipient: true, recipientName: true, subject: true, status: true, error: true, category: true, sentAt: true },
    }),
    client.communicationLog.findFirst({
      where: { channel: 'email', status: 'DELIVERED' },
      orderBy: { sentAt: 'desc' },
      select: { sentAt: true },
    }),
    client.emailSuppression.groupBy({ by: ['reason'], where: { resubscribedAt: null }, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
  const summary = summarizeDelivery(counts, {
    awaitingFeedback,
    eligibleForFeedback,
    feedbackConfigured: Boolean(env.SES_CONFIGURATION_SET && env.SES_SNS_TOPIC_ARN),
  });

  return {
    days,
    since,
    ...summary,
    lastDeliveredAt: lastDelivered?.sentAt ?? null,
    problems,
    suppressions: Object.fromEntries(suppressions.map((g) => [g.reason, g._count._all])),
  };
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

export async function recentTestSends({ client = prisma } = {}) {
  return client.communicationLog.findMany({
    where: { channel: 'email', category: 'TEST' },
    orderBy: { sentAt: 'desc' },
    take: 5,
    select: { id: true, recipient: true, subject: true, status: true, error: true, sentAt: true },
  });
}

export async function emailHealthReport({ days = 7, env = process.env, ses, resolver } = {}) {
  const [configuration, sesResult, dnsResult, delivery, tests] = await Promise.all([
    configurationChecks(env),
    sesChecks({ env, client: ses }).catch((error) => [
      check('ses', 'Amazon SES', STATUS.UNKNOWN, `Could not check: ${error.message}.`),
    ]),
    dnsChecks({ env, resolver }).catch((error) => [
      check('dns', 'DNS', STATUS.UNKNOWN, `Could not check: ${error.message}.`),
    ]),
    // A database outage must not take the SES and DNS answers down with it:
    // "is email working?" is exactly what gets asked while something is down.
    deliveryReport({ days, env }).catch((error) => {
      console.error('[emailHealth] delivery report failed:', error.message);
      return { checks: [check('log', 'Communications log', STATUS.UNKNOWN, 'Could not read the log from the database.')] };
    }),
    recentTestSends().catch(() => []),
  ]);

  const { checks: deliveryChecks, ...deliveryData } = delivery;
  const sections = [
    { key: 'configuration', title: 'Server configuration', checks: configuration },
    { key: 'ses', title: 'Amazon SES', checks: sesResult },
    { key: 'dns', title: `DNS for ${domainOf(parseFromAddress(env.EMAIL_FROM)) || 'the From domain'}`, checks: dnsResult },
    { key: 'delivery', title: `Delivery, last ${days} days`, checks: deliveryChecks },
  ].filter((s) => s.checks.length > 0);

  return {
    checkedAt: new Date(),
    overall: worstStatus(sections.flatMap((s) => s.checks.map((c) => c.status))),
    fromAddress: parseFromAddress(env.EMAIL_FROM),
    sections,
    // Null when the log could not be read; the page hides what depends on it.
    delivery: deliveryData.totals ? deliveryData : null,
    recentTests: tests,
  };
}
