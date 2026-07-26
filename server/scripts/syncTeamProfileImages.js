import fetch from 'node-fetch';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_SOURCE_URL = 'https://uconsulting.club/team/';
const ALLOWED_EXTENSIONS = ['jpeg', 'jpg', 'png', 'gif'];
const MIME_TO_EXTENSION = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
};
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

const HELP_TEXT = `Sync UConsulting team-page profile photos to ATS member accounts.

Usage: node scripts/syncTeamProfileImages.js [options]

Options:
  --apply                 Apply updates (default is dry-run).
  --overwrite             Overwrite existing profileImage values.
  --source-url <url>      Team page URL (default: ${DEFAULT_SOURCE_URL}).
  --html-file <path>      Use a locally saved copy of the team page instead of fetching.
  --upload-dir <path>     Directory for downloaded images (default: server/uploads/profile-images).
  --json                  Output the report as JSON.
  --dry-run               Report only; do not write any files or database rows (default).
  -h, --help              Show this help message.

Examples:
  node scripts/syncTeamProfileImages.js --dry-run
  node scripts/syncTeamProfileImages.js --apply
  node scripts/syncTeamProfileImages.js --apply --html-file ./team-page.html
`;

export function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseTeamPageHtml(html) {
  const rows = [];
  const blockRe = /<div[^>]*class="[^"]*eael-team-item[^"]*"[^>]*>([\s\S]*?)<h2 class="eael-team-member-name">([^<]*)<\/h2>/gi;
  const srcRe = /src="([^"]+)"/;
  let match;

  while ((match = blockRe.exec(html)) !== null) {
    const block = match[1];
    const name = match[2].trim();
    const srcMatch = block.match(srcRe);
    const imageUrl = srcMatch ? srcMatch[1] : null;

    if (name && imageUrl) {
      rows.push({ name, imageUrl });
    }
  }

  return rows;
}

export function deduplicateAndValidate(rows) {
  const groups = new Map();

  for (const row of rows) {
    const normalized = normalizeName(row.name);
    if (!normalized) continue;

    if (!groups.has(normalized)) {
      groups.set(normalized, { rawNames: [], imageUrls: new Set() });
    }
    const group = groups.get(normalized);
    group.rawNames.push(row.name);
    group.imageUrls.add(row.imageUrl);
  }

  const candidates = [];
  const conflicts = [];

  for (const [normalizedName, group] of groups) {
    const uniqueUrls = [...group.imageUrls];
    const uniqueRawNames = [...new Set(group.rawNames)];

    if (uniqueUrls.length > 1) {
      conflicts.push({
        normalizedName,
        rawNames: uniqueRawNames,
        imageUrls: uniqueUrls,
      });
    } else {
      candidates.push({
        normalizedName,
        rawName: uniqueRawNames[0] || group.rawNames[0],
        imageUrl: uniqueUrls[0],
      });
    }
  }

  return { candidates, conflicts };
}

export function matchUsers(candidates, users, options = {}) {
  const { overwrite = false } = options;

  const userByNormalized = new Map();
  const ambiguousUserNames = new Set();

  for (const user of users) {
    const normalized = normalizeName(user.fullName);
    if (!normalized) continue;

    if (userByNormalized.has(normalized)) {
      ambiguousUserNames.add(normalized);
      userByNormalized.delete(normalized);
    } else if (!ambiguousUserNames.has(normalized)) {
      userByNormalized.set(normalized, user);
    }
  }

  const matchedUserKeys = new Set();
  const matches = [];
  const skipped = [];
  const unmatchedSource = [];
  const ambiguous = [];

  for (const candidate of candidates) {
    if (ambiguousUserNames.has(candidate.normalizedName)) {
      ambiguous.push({ candidate, reason: 'ambiguous-user' });
      continue;
    }

    const user = userByNormalized.get(candidate.normalizedName);
    if (!user) {
      unmatchedSource.push(candidate);
      continue;
    }

    matchedUserKeys.add(candidate.normalizedName);

    if (!overwrite && user.profileImage) {
      skipped.push({ user, candidate });
    } else {
      matches.push({ user, candidate });
    }
  }

  const unmatchedUsers = users.filter((u) => !matchedUserKeys.has(normalizeName(u.fullName)));

  return { matches, skipped, unmatchedSource, unmatchedUsers, ambiguous };
}

function getImageExtension(imageUrl, contentType = '') {
  let pathname;
  try {
    pathname = new URL(imageUrl).pathname;
  } catch {
    pathname = '';
  }

  const extFromUrl = path.extname(pathname).toLowerCase().replace(/^\./, '');
  if (ALLOWED_EXTENSIONS.includes(extFromUrl)) {
    return extFromUrl === 'jpeg' ? 'jpg' : extFromUrl;
  }

  const cleanMime = contentType.split(';')[0].trim().toLowerCase();
  const extFromMime = MIME_TO_EXTENSION[cleanMime];
  if (extFromMime) return extFromMime;

  throw new Error(
    `Unsupported image format for ${imageUrl}: URL extension "${extFromUrl || 'none'}", content-type "${contentType || 'none'}"`
  );
}

async function downloadImage(imageUrl, fetchFn) {
  const response = await fetchFn(imageUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download image ${imageUrl}: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);

  if (contentLength > MAX_FILE_SIZE) {
    throw new Error(`Image ${imageUrl} exceeds 5MB limit`);
  }

  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`Unexpected content type "${contentType}" for ${imageUrl}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`Image ${imageUrl} exceeds 5MB limit after download`);
  }

  return { buffer, contentType };
}

export async function uploadProfileImage({
  imageUrl,
  uploadDir,
  fetchFn,
  now = Date.now,
  random = () => Math.floor(Math.random() * 1e9),
  fs: fsDep = fs,
  path: pathDep = path,
}) {
  const { buffer, contentType } = await downloadImage(imageUrl, fetchFn);
  const ext = getImageExtension(imageUrl, contentType);
  const filename = `profile-${now()}-${random()}.${ext}`;
  const outputPath = pathDep.join(uploadDir, filename);

  await fsDep.promises.mkdir(uploadDir, { recursive: true });
  await fsDep.promises.writeFile(outputPath, buffer);

  return `/api/uploads/profile-images/${filename}`;
}

export async function runSync(options, deps = {}) {
  const {
    sourceUrl = DEFAULT_SOURCE_URL,
    htmlFile,
    apply = false,
    overwrite = false,
    uploadDir,
  } = options;

  const fetchFn = deps.fetch || fetch;
  const fsDep = deps.fs || fs;
  const prisma = deps.prisma;
  const now = deps.now || Date.now;
  const random = deps.random || (() => Math.floor(Math.random() * 1e9));

  // 1. Load source HTML.
  let html;
  let sourceType = 'url';
  if (htmlFile) {
    sourceType = 'file';
    html = await fsDep.promises.readFile(htmlFile, 'utf8');
  } else {
    const response = await fetchFn(sourceUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      const fallbackHint =
        response.status === 406
          ? 'ModSecurity rejected the request (HTTP 406).'
          : `The page returned HTTP ${response.status} ${response.statusText}.`;
      throw new Error(
        `${fallbackHint} ` +
          'Fetch the page through a browser and pass --html-file, or provide an approved mapping. ' +
          'Do not bypass access controls.'
      );
    }

    html = await response.text();
  }

  // 2. Parse, deduplicate, and validate.
  const rows = parseTeamPageHtml(html);
  const { candidates, conflicts } = deduplicateAndValidate(rows);

  // 3. Load ATS users and match by normalized full name.
  let users = [];
  if (prisma) {
    users = await prisma.user.findMany({
      select: { id: true, fullName: true, profileImage: true, email: true },
    });
  }

  const matchResult = matchUsers(candidates, users, { overwrite });

  const report = {
    source: htmlFile || sourceUrl,
    sourceType,
    apply,
    overwrite,
    parsedRows: rows.length,
    candidates: candidates.length,
    conflicts,
    ambiguous: matchResult.ambiguous,
    exactMatches: matchResult.matches.length + matchResult.skipped.length,
    skipped: matchResult.skipped,
    unmatchedSource: matchResult.unmatchedSource,
    unmatchedUsers: matchResult.unmatchedUsers,
    uploaded: [],
    errors: [],
  };

  const blockingIssues = conflicts.length > 0 || matchResult.ambiguous.length > 0;

  // 4. Apply changes only when explicitly requested and no blocking issues exist.
  if (apply) {
    if (!prisma) {
      throw new Error('--apply requires a Prisma client. This script must be run with database access.');
    }
    if (blockingIssues) {
      throw new Error(
        `Cannot apply: ${conflicts.length} conflicting source name(s) and ${matchResult.ambiguous.length} ambiguous user match(es) found. Resolve them and re-run.`
      );
    }
    if (!uploadDir) {
      throw new Error('--upload-dir is required when --apply is set');
    }

    for (const { user, candidate } of matchResult.matches) {
      try {
        const storedPath = await uploadProfileImage({
          imageUrl: candidate.imageUrl,
          uploadDir,
          fetchFn,
          now,
          random,
          fs: fsDep,
        });

        const updatedUser = await prisma.user.update({
          where: { id: user.id },
          data: { profileImage: storedPath },
          select: { id: true, fullName: true, profileImage: true },
        });

        // Verify by reading the updated record back.
        const verified = await prisma.user.findUnique({
          where: { id: user.id },
          select: { id: true, fullName: true, profileImage: true },
        });

        report.uploaded.push({
          userId: user.id,
          fullName: user.fullName,
          normalizedName: candidate.normalizedName,
          imageUrl: candidate.imageUrl,
          storedPath,
          verified: verified?.profileImage === storedPath,
        });
      } catch (err) {
        report.errors.push({
          userId: user.id,
          fullName: user.fullName,
          normalizedName: candidate.normalizedName,
          imageUrl: candidate.imageUrl,
          error: err.message,
        });
      }
    }
  }

  return report;
}

function formatReport(report) {
  const lines = [];
  lines.push(`Source: ${report.source} (${report.sourceType})`);
  lines.push(`Mode: ${report.apply ? 'apply' : 'dry-run'}`);
  lines.push(`Parsed rows: ${report.parsedRows}, unique candidates: ${report.candidates}`);
  lines.push(`Exact matches: ${report.exactMatches}`);
  lines.push(`Skipped (profileImage already set): ${report.skipped.length}`);
  lines.push(`Unmatched website names: ${report.unmatchedSource.length}`);
  lines.push(`Unmatched ATS users: ${report.unmatchedUsers.length}`);
  lines.push(`Conflicting source names: ${report.conflicts.length}`);
  lines.push(`Ambiguous user matches: ${report.ambiguous.length}`);

  if (report.conflicts.length) {
    lines.push('\nConflicting source rows (same normalized name, different image URLs):');
    for (const c of report.conflicts) {
      lines.push(`  - "${c.normalizedName}" -> ${c.imageUrls.join(', ')}`);
    }
  }

  if (report.ambiguous.length) {
    lines.push('\nAmbiguous ATS user matches (multiple users with the same normalized full name):');
    for (const a of report.ambiguous) {
      lines.push(`  - "${a.candidate.normalizedName}"`);
    }
  }

  if (report.unmatchedSource.length) {
    lines.push('\nUnmatched website names:');
    for (const u of report.unmatchedSource) {
      lines.push(`  - "${u.rawName}" (${u.imageUrl})`);
    }
  }

  if (report.skipped.length) {
    lines.push('\nSkipped because profileImage is already set:');
    for (const s of report.skipped) {
      lines.push(`  - ${s.user.id} "${s.user.fullName}"`);
    }
  }

  if (report.uploaded.length) {
    lines.push('\nUploaded / updated:');
    for (const u of report.uploaded) {
      lines.push(`  - ${u.userId} "${u.fullName}" -> ${u.storedPath} (verified: ${u.verified})`);
    }
  }

  if (report.errors.length) {
    lines.push('\nErrors during apply:');
    for (const e of report.errors) {
      lines.push(`  - ${e.userId || ''} "${e.fullName || ''}": ${e.error}`);
    }
  }

  return lines.join('\n');
}

function parseArgs(argv) {
  const args = {
    apply: false,
    overwrite: false,
    sourceUrl: DEFAULT_SOURCE_URL,
    htmlFile: null,
    uploadDir: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--apply':
        args.apply = true;
        break;
      case '--overwrite':
        args.overwrite = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case '--source-url':
        args.sourceUrl = argv[++i];
        break;
      case '--html-file':
        args.htmlFile = argv[++i];
        break;
      case '--upload-dir':
        args.uploadDir = argv[++i];
        break;
      case '--json':
        args.json = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (arg.startsWith('--')) {
          throw new Error(`Unknown option: ${arg}`);
        }
        break;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const defaultUploadDir = path.resolve(__dirname, '../uploads/profile-images');
  const uploadDir = args.uploadDir || defaultUploadDir;

  const { default: prisma } = await import('../src/prismaClient.js');

  const report = await runSync(
    { ...args, uploadDir },
    { prisma }
  );

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }

  const hasFatal =
    (report.apply && (report.conflicts.length > 0 || report.ambiguous.length > 0)) ||
    report.errors.length > 0;

  process.exit(hasFatal ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Profile image sync failed:', error.message || error);
    process.exit(1);
  });
}
