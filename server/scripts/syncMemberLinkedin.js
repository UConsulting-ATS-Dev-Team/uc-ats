// Fills each member's GTKUC LinkedIn link from the UConsulting team page, which
// is where members already publish it. We read our own site rather than
// LinkedIn: LinkedIn profiles are auth-walled and scraping them is against
// their terms, so the team page is the source of truth we control.
//
// Dry-run by default; pass --apply to write.
//
//   node scripts/syncMemberLinkedin.js
//   node scripts/syncMemberLinkedin.js --apply
//   node scripts/syncMemberLinkedin.js --apply --overwrite
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import prisma from '../src/prismaClient.js';
import { normalizeLinkedinUrl } from '../src/utils/gtkucProfile.js';
import { normalizeName } from './syncTeamProfileImages.js';

const DEFAULT_SOURCE_URL = 'https://uconsulting.club/team/';

const HELP_TEXT = `Sync UConsulting team-page LinkedIn links to member GTKUC profiles.

Usage: node scripts/syncMemberLinkedin.js [options]

Options:
  --apply             Write the matches (default is a dry run).
  --overwrite         Replace LinkedIn links that are already set.
  --source-url <url>  Team page URL (default: ${DEFAULT_SOURCE_URL}).
  --html-file <path>  Parse a saved copy of the team page instead of fetching.
  --json              Print the report as JSON.
  -h, --help          Show this message.
`;

// Each team item carries the member's name and, when they listed it, a LinkedIn
// anchor in the same block. Names without a LinkedIn link are simply skipped.
export function parseTeamPageLinkedin(html) {
  const rows = [];
  const itemRe = /<div[^>]*class="[^"]*eael-team-item[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*eael-team-item|$)/gi;
  const nameRe = /<h2 class="eael-team-member-name">([^<]*)<\/h2>/i;
  const linkedinRe = /href="([^"]*linkedin\.com\/(?:in|pub)\/[^"]*)"/i;

  let match;
  while ((match = itemRe.exec(html)) !== null) {
    const block = match[1];
    const name = block.match(nameRe)?.[1]?.trim();
    const href = block.match(linkedinRe)?.[1];
    if (!name || !href) continue;

    const linkedinUrl = normalizeLinkedinUrl(href);
    if (linkedinUrl) rows.push({ name, linkedinUrl });
  }

  return rows;
}

// One entry per member name. Two kinds of team-page data errors are reported
// and skipped rather than guessed at: one name carrying two different LinkedIn
// URLs, and one LinkedIn URL shared by several member cards (the tell of a
// copy-pasted card — writing it would hand candidates the wrong person).
export function deduplicate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const normalized = normalizeName(row.name);
    if (!normalized) continue;
    if (!groups.has(normalized)) groups.set(normalized, { rawNames: [], urls: new Set() });
    const group = groups.get(normalized);
    group.rawNames.push(row.name);
    group.urls.add(row.linkedinUrl);
  }

  const nameCountByUrl = new Map();
  for (const group of groups.values()) {
    for (const url of group.urls) {
      nameCountByUrl.set(url, (nameCountByUrl.get(url) || 0) + 1);
    }
  }

  const candidates = [];
  const conflicts = [];
  for (const [normalizedName, group] of groups) {
    const urls = [...group.urls];
    const rawName = group.rawNames[0];
    if (urls.length > 1) conflicts.push({ normalizedName, rawName, urls, reason: 'multiple-urls' });
    else if (nameCountByUrl.get(urls[0]) > 1)
      conflicts.push({ normalizedName, rawName, urls, reason: 'url-shared-by-several-members' });
    else candidates.push({ normalizedName, rawName, linkedinUrl: urls[0] });
  }

  return { candidates, conflicts };
}

export function matchMembers(candidates, members, { overwrite = false } = {}) {
  const byName = new Map();
  const ambiguousNames = new Set();

  for (const member of members) {
    const normalized = normalizeName(member.fullName);
    if (!normalized) continue;
    if (byName.has(normalized)) {
      ambiguousNames.add(normalized);
      byName.delete(normalized);
    } else if (!ambiguousNames.has(normalized)) {
      byName.set(normalized, member);
    }
  }

  const matches = [];
  const skipped = [];
  const unmatchedSource = [];
  const ambiguous = [];

  for (const candidate of candidates) {
    if (ambiguousNames.has(candidate.normalizedName)) {
      ambiguous.push(candidate);
      continue;
    }
    const member = byName.get(candidate.normalizedName);
    if (!member) {
      unmatchedSource.push(candidate);
      continue;
    }
    const current = member.gtkucProfile?.linkedinUrl || null;
    if (current && !overwrite) skipped.push({ member, candidate, current });
    else if (current === candidate.linkedinUrl) skipped.push({ member, candidate, current });
    else matches.push({ member, candidate, current });
  }

  return { matches, skipped, unmatchedSource, ambiguous };
}

function parseArgs(argv) {
  const options = { apply: false, overwrite: false, json: false, sourceUrl: DEFAULT_SOURCE_URL, htmlFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--overwrite') options.overwrite = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--source-url') options.sourceUrl = argv[++i];
    else if (arg === '--html-file') options.htmlFile = argv[++i];
    else if (arg === '-h' || arg === '--help') options.help = true;
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const html = options.htmlFile
    ? fs.readFileSync(options.htmlFile, 'utf8')
    : await fetch(options.sourceUrl).then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch ${options.sourceUrl}: HTTP ${res.status}`);
        return res.text();
      });

  const { candidates, conflicts } = deduplicate(parseTeamPageLinkedin(html));

  const members = await prisma.user.findMany({
    where: { role: { in: ['MEMBER', 'ADMIN'] }, isActive: true },
    select: { id: true, fullName: true, gtkucProfile: { select: { linkedinUrl: true } } }
  });

  const report = matchMembers(candidates, members, { overwrite: options.overwrite });

  if (options.apply) {
    for (const { member, candidate } of report.matches) {
      await prisma.memberGtkucProfile.upsert({
        where: { memberId: member.id },
        create: { memberId: member.id, industries: [], interests: [], linkedinUrl: candidate.linkedinUrl },
        update: { linkedinUrl: candidate.linkedinUrl }
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ...report, conflicts, applied: options.apply }, null, 2));
  } else {
    console.log(`Team page entries with a LinkedIn link: ${candidates.length}`);
    console.log(`${options.apply ? 'Updated' : 'Would update'}: ${report.matches.length}`);
    for (const { member, candidate, current } of report.matches) {
      console.log(`  ${member.fullName}: ${current || '(none)'} -> ${candidate.linkedinUrl}`);
    }
    console.log(`Already set / unchanged: ${report.skipped.length}`);
    console.log(`On the team page but not in the ATS: ${report.unmatchedSource.length}`);
    for (const c of report.unmatchedSource) console.log(`  ${c.rawName}`);
    if (report.ambiguous.length) console.log(`Ambiguous names (skipped): ${report.ambiguous.map((c) => c.rawName).join(', ')}`);
    if (conflicts.length) {
      console.log(`Conflicting team-page links (skipped, fix on the website):`);
      for (const c of conflicts) console.log(`  ${c.rawName} — ${c.reason}: ${c.urls.join(', ')}`);
    }
    if (!options.apply) console.log('\nDry run — re-run with --apply to write.');
  }

  await prisma.$disconnect();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(async (error) => {
    console.error(error.message);
    await prisma.$disconnect();
    process.exit(1);
  });
}
