import config from '../../config.js';
import prisma from '../../prismaClient.js';
import { isExecPasswordConfigured } from '../execAccess.js';
import { getSyncTokenState } from '../luma/syncToken.js';

// A live checklist of how this deployment is configured, for the Security tab.
// Reads configuration and a few counts; changes nothing. Every check is
// independent, so one that cannot run reports UNKNOWN instead of hiding the rest.
//
// Statuses: PASS, WARN (worth fixing), FAIL (fix now), INFO (context, no verdict),
// UNKNOWN (the check itself could not run).

const PLACEHOLDER = /^(secret|changeme|change-me|password|test|example|your[-_]?secret.*|test-.*|.*do-not-use.*)$/i;
const MIN_SECRET = 32;
// More admins than this is worth a second look, not an error.
const ADMIN_COUNT_WARN = 8;

const check = (key, label, status, detail) => ({ key, label, status, detail });

function secretCheck(key, label, value, { failWhenMissing = true } = {}) {
  if (!value) return check(key, label, failWhenMissing ? 'FAIL' : 'WARN', 'Not set.');
  if (PLACEHOLDER.test(value)) return check(key, label, 'FAIL', 'Set to a placeholder value.');
  if (value.length < MIN_SECRET) return check(key, label, 'WARN', `Shorter than ${MIN_SECRET} characters.`);
  return check(key, label, 'PASS', `${value.length} characters.`);
}

const safely = async (key, label, fn) => {
  try {
    return await fn();
  } catch (error) {
    return check(key, label, 'UNKNOWN', `Could not check: ${error?.message || error}`);
  }
};

export async function runPostureChecks({ env = process.env, cfg = config, client = prisma } = {}) {
  const production = env.NODE_ENV === 'production';
  const checks = [];

  checks.push(secretCheck('jwt_secret', 'JWT signing secret', env.JWT_SECRET));

  checks.push(
    env.LIVE_VOTE_SECRET
      ? secretCheck('live_vote_secret', 'Live vote ballot secret', env.LIVE_VOTE_SECRET)
      : check('live_vote_secret', 'Live vote ballot secret', 'WARN', 'Not set; falls back to the JWT secret, so one leaked secret exposes both.')
  );
  checks.push(
    env.UNSUBSCRIBE_SECRET
      ? secretCheck('unsubscribe_secret', 'Unsubscribe link secret', env.UNSUBSCRIBE_SECRET)
      : check('unsubscribe_secret', 'Unsubscribe link secret', 'WARN', 'Not set; falls back to the JWT secret. Set it once and leave it: rotating breaks links already sent.')
  );

  const token = env.MEMBER_REGISTRATION_TOKEN || '';
  checks.push(
    !token || PLACEHOLDER.test(token)
      ? check('member_registration_token', 'Member registration token', 'FAIL', 'Missing or a placeholder: anyone could register as a member.')
      : token.length < 16
        ? check('member_registration_token', 'Member registration token', 'WARN', 'Shorter than 16 characters.')
        : check('member_registration_token', 'Member registration token', 'PASS', `${token.length} characters.`)
  );

  const origins = cfg.corsOrigin || [];
  if (!origins.length) checks.push(check('cors_origin', 'CORS allowlist', 'FAIL', 'Empty.'));
  else if (origins.includes('*')) checks.push(check('cors_origin', 'CORS allowlist', 'FAIL', 'Contains "*".'));
  else if (production && origins.some((o) => !o.startsWith('https://')))
    checks.push(check('cors_origin', 'CORS allowlist', 'WARN', `Non-HTTPS origin allowed: ${origins.filter((o) => !o.startsWith('https://')).join(', ')}`));
  else checks.push(check('cors_origin', 'CORS allowlist', 'PASS', origins.join(', ')));

  checks.push(
    production
      ? check('node_env', 'Production mode', 'PASS', 'NODE_ENV=production.')
      : check('node_env', 'Production mode', 'INFO', `NODE_ENV=${env.NODE_ENV || '(unset)'}; expected outside production.`)
  );

  checks.push(check('helmet', 'Security headers', 'PASS', 'helmet() is applied to every response.'));
  checks.push(check('error_handler', 'Error responses', 'PASS', 'Uncaught route errors answer JSON without a stack trace.'));
  checks.push(check('debug_endpoint', 'Debug endpoints', 'PASS', 'The public /api/test-uploads endpoint has been removed.'));
  checks.push(
    check(
      'login_rate_limit',
      'Sign-in rate limit',
      'WARN',
      'POST /api/auth/login has no rate limit. Brute force is detected and reported here, but not blocked.'
    )
  );

  checks.push(
    env.SES_CONFIGURATION_SET && env.SES_SNS_TOPIC_ARN
      ? check('ses_events', 'Email delivery reporting', 'PASS', 'SES configuration set and SNS topic are both set.')
      : check('ses_events', 'Email delivery reporting', 'WARN', 'SES_CONFIGURATION_SET or SES_SNS_TOPIC_ARN is unset, so bounces and complaints never reach the log.')
  );

  checks.push(
    env.DIRECT_URL
      ? check('direct_url', 'Migration database URL', 'INFO', 'DIRECT_URL is set.')
      : check('direct_url', 'Migration database URL', 'INFO', 'DIRECT_URL is unset; migrations are applied by hand.')
  );

  const [luma, exec, admins, unreachable] = await Promise.all([
    safely('luma_sync_token', 'Luma sync token', async () => {
      const state = await getSyncTokenState();
      return state.configured
        ? check('luma_sync_token', 'Luma sync token', 'INFO', state.token ? 'A generated token is in use.' : 'Using LUMA_SYNC_TOKEN from the environment.')
        : check('luma_sync_token', 'Luma sync token', 'INFO', 'Not configured; the Luma endpoints refuse every call.');
    }),
    safely('exec_password', 'Executive unlock password', async () =>
      (await isExecPasswordConfigured(client))
        ? check('exec_password', 'Executive unlock password', 'PASS', 'Set.')
        : check('exec_password', 'Executive unlock password', 'WARN', 'Not set; sealed records cannot be unlocked by anyone.')
    ),
    safely('admin_accounts', 'Admin accounts', async () => {
      const rows = await client.user.findMany({
        where: { role: 'ADMIN' },
        select: { email: true, isActive: true },
      });
      const active = rows.filter((r) => r.isActive !== false);
      const inactive = rows.length - active.length;
      const status = active.length > ADMIN_COUNT_WARN ? 'WARN' : 'INFO';
      const extra = inactive ? ` ${inactive} deactivated account(s) still carry the ADMIN role.` : '';
      return check('admin_accounts', 'Admin accounts', status, `${active.length} active admin(s).${extra}`);
    }),
    safely('unreachable_staff', 'Staff without a sign-in method', async () => {
      const count = await client.user.count({
        where: { role: { in: ['ADMIN', 'MEMBER'] }, isActive: true, password: null, googleId: null },
      });
      return check(
        'unreachable_staff',
        'Staff without a sign-in method',
        'INFO',
        count ? `${count} active staff account(s) have neither a password nor Google linked; only a password reset gets them in.` : 'None.'
      );
    }),
  ]);
  checks.push(luma, exec, admins, unreachable);

  const order = { FAIL: 0, WARN: 1, UNKNOWN: 2, INFO: 3, PASS: 4 };
  return checks.sort((a, b) => order[a.status] - order[b.status]);
}
