import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  normalizeName,
  parseTeamPageHtml,
  deduplicateAndValidate,
  matchUsers,
  uploadProfileImage,
  runSync,
} from './syncTeamProfileImages.js';

const applyFixtureHtml = `
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/alice.png" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Alice Smith</h2>
      <h3 class="eael-team-member-position">President</h3>
    </div>
  </div>
</div>
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/bob.jpg" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Bob-Jones</h2>
      <h3 class="eael-team-member-position">Director</h3>
    </div>
  </div>
</div>
`;

const fixtureHtml = `
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/alice.png" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Alice  Smith</h2>
      <h3 class="eael-team-member-position">President</h3>
    </div>
  </div>
</div>
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/bob.jpg" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Bob-Jones</h2>
      <h3 class="eael-team-member-position">Director</h3>
    </div>
  </div>
</div>
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/charlie.png" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Charlie O'Neil</h2>
      <h3 class="eael-team-member-position">Advisor</h3>
    </div>
  </div>
</div>
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/diana1.png" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Diana Prince</h2>
      <h3 class="eael-team-member-position">Project Manager</h3>
    </div>
  </div>
</div>
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/diana1.png" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Diana Prince</h2>
      <h3 class="eael-team-member-position">Senior Consultant</h3>
    </div>
  </div>
</div>
<div class="eael-team-item eael-team-members-simple team-avatar-rounded">
  <div class="eael-team-item-inner">
    <div class="eael-team-image"><figure><img src="https://example.com/diana2.png" alt=""></figure></div>
    <div class="eael-team-content">
      <h2 class="eael-team-member-name">Diana Prince</h2>
      <h3 class="eael-team-member-position">Consultant</h3>
    </div>
  </div>
</div>
`;

function createMockResponse(overrides = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Map([['content-type', 'image/png']]),
    arrayBuffer: async () => Buffer.from('fake-image-data'),
    text: async () => '',
    ...overrides,
  };
}

function createMockFetch({ sourceHtml, imageBuffer, contentType = 'image/png' } = {}) {
  return vi.fn(async (url) => {
    if (typeof url === 'string' && (url.endsWith('.html') || url.startsWith('http'))) {
      const isHtml = url.includes('team') || url.endsWith('.html') || sourceHtml;
      if (isHtml) {
        return createMockResponse({
          text: async () => sourceHtml || fixtureHtml,
          headers: new Map([['content-type', 'text/html; charset=utf-8']]),
        });
      }
    }
    return createMockResponse({
      arrayBuffer: async () => imageBuffer || Buffer.from('fake-image-data'),
      headers: new Map([['content-type', contentType]]),
    });
  });
}

describe('normalizeName', () => {
  it('lowercases and trims names', () => {
    expect(normalizeName('Alice Smith')).toBe('alice smith');
    expect(normalizeName('  Alice   Smith  ')).toBe('alice smith');
  });

  it('removes punctuation and treats hyphens as spaces', () => {
    expect(normalizeName("Charlie O'Neil")).toBe('charlie oneil');
    expect(normalizeName('Bob-Jones')).toBe('bob jones');
    expect(normalizeName('Dr. Alice Smith, PhD')).toBe('dr alice smith phd');
  });

  it('handles empty or invalid input', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('parseTeamPageHtml', () => {
  it('extracts member names and image URLs', () => {
    const rows = parseTeamPageHtml(fixtureHtml);
    expect(rows.length).toBe(6);
    expect(rows[0]).toEqual({ name: 'Alice  Smith', imageUrl: 'https://example.com/alice.png' });
    expect(rows[2]).toEqual({ name: "Charlie O'Neil", imageUrl: 'https://example.com/charlie.png' });
  });

  it('returns an empty array when no team-member blocks exist', () => {
    expect(parseTeamPageHtml('<html><body><h1>No team here</h1></body></html>')).toEqual([]);
  });
});

describe('deduplicateAndValidate', () => {
  it('deduplicates repeated names with the same image URL', () => {
    const rows = [
      { name: 'Alice Smith', imageUrl: 'https://example.com/alice.png' },
      { name: 'Alice Smith', imageUrl: 'https://example.com/alice.png' },
    ];
    const { candidates, conflicts } = deduplicateAndValidate(rows);
    expect(candidates.length).toBe(1);
    expect(conflicts.length).toBe(0);
    expect(candidates[0].normalizedName).toBe('alice smith');
  });

  it('detects conflicting image URLs for the same normalized name', () => {
    const { candidates, conflicts } = deduplicateAndValidate(parseTeamPageHtml(fixtureHtml));
    expect(candidates.length).toBe(3);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].normalizedName).toBe('diana prince');
    expect(conflicts[0].imageUrls).toContain('https://example.com/diana1.png');
    expect(conflicts[0].imageUrls).toContain('https://example.com/diana2.png');
  });
});

describe('matchUsers', () => {
  const users = [
    { id: 'u1', fullName: 'Alice Smith', profileImage: null },
    { id: 'u2', fullName: 'Bob Jones', profileImage: null },
    { id: 'u3', fullName: 'Charlie Oneil', profileImage: '/api/uploads/profile-images/old.png' },
    { id: 'u4', fullName: 'Eve Unknown', profileImage: null },
  ];

  it('matches exact normalized full names', () => {
    const { candidates } = deduplicateAndValidate(parseTeamPageHtml(fixtureHtml));
    const { matches, skipped, unmatchedSource, unmatchedUsers, ambiguous } = matchUsers(candidates, users);

    expect(matches.length).toBe(2); // Alice and Bob
    expect(matches.map((m) => m.user.id)).toContain('u1');
    expect(matches.map((m) => m.user.id)).toContain('u2');
    expect(skipped.length).toBe(1); // Charlie already has profileImage
    expect(unmatchedSource.length).toBe(0);
    expect(unmatchedUsers.map((u) => u.id)).toContain('u4');
    expect(ambiguous.length).toBe(0);
  });

  it('skips existing profile images unless overwrite is enabled', () => {
    const { candidates } = deduplicateAndValidate(parseTeamPageHtml(fixtureHtml));
    const { matches, skipped } = matchUsers(candidates, users, { overwrite: true });
    expect(matches.map((m) => m.user.id)).toContain('u3');
    expect(skipped.length).toBe(0);
  });

  it('flags ambiguous user matches when multiple users normalize to the same full name', () => {
    const ambiguousUsers = [
      ...users,
      { id: 'u5', fullName: 'Alice Smith', profileImage: null },
    ];
    const { candidates } = deduplicateAndValidate(parseTeamPageHtml(fixtureHtml));
    const { matches, ambiguous } = matchUsers(candidates, ambiguousUsers);
    expect(ambiguous.length).toBe(1);
    expect(ambiguous[0].candidate.normalizedName).toBe('alice smith');
    expect(matches.map((m) => m.user.id)).not.toContain('u1');
    expect(matches.map((m) => m.user.id)).not.toContain('u5');
  });
});

describe('uploadProfileImage', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-sync-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads an image and saves it to the upload directory', async () => {
    const fetchFn = createMockFetch({ imageBuffer: Buffer.from('png-bytes') });
    const storedPath = await uploadProfileImage({
      imageUrl: 'https://example.com/alice.png',
      uploadDir: tmpDir,
      fetchFn,
      now: () => 123456789,
      random: () => 42,
    });

    expect(storedPath).toMatch(/^\/api\/uploads\/profile-images\/profile-123456789-42\.png$/);
    const filename = path.basename(storedPath);
    const filePath = path.join(tmpDir, filename);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).toString()).toBe('png-bytes');
  });

  it('derives the extension from the content type when the URL has no extension', async () => {
    const fetchFn = createMockFetch({
      imageBuffer: Buffer.from('jpeg-bytes'),
      contentType: 'image/jpeg',
    });
    const storedPath = await uploadProfileImage({
      imageUrl: 'https://example.com/unknown',
      uploadDir: tmpDir,
      fetchFn,
      now: () => 1,
      random: () => 0,
    });
    expect(storedPath.endsWith('.jpg')).toBe(true);
  });

  it('throws for non-image content types', async () => {
    const fetchFn = createMockFetch({ contentType: 'text/html' });
    await expect(
      uploadProfileImage({
        imageUrl: 'https://example.com/evil.html',
        uploadDir: tmpDir,
        fetchFn,
      })
    ).rejects.toThrow(/Unexpected content type/);
  });

  it('throws when the downloaded file exceeds 5MB', async () => {
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024);
    const fetchFn = createMockFetch({ imageBuffer: bigBuffer });
    await expect(
      uploadProfileImage({
        imageUrl: 'https://example.com/huge.png',
        uploadDir: tmpDir,
        fetchFn,
      })
    ).rejects.toThrow(/exceeds 5MB/);
  });
});

describe('runSync', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-sync-run-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const createPrisma = (users) => ({
    user: {
      findMany: vi.fn().mockResolvedValue(users),
      update: vi.fn(({ data, where }) => {
        const user = users.find((u) => u.id === where.id);
        if (user) user.profileImage = data.profileImage;
        return Promise.resolve({
          id: where.id,
          fullName: user?.fullName,
          profileImage: data.profileImage,
        });
      }),
      findUnique: vi.fn(({ where }) =>
        Promise.resolve(users.find((u) => u.id === where.id))
      ),
    },
  });

  it('performs a dry run without writing files or database rows', async () => {
    const users = [
      { id: 'u1', fullName: 'Alice Smith', profileImage: null },
      { id: 'u2', fullName: 'Bob Jones', profileImage: null },
    ];
    const prisma = createPrisma(users);
    const fetchFn = createMockFetch({ sourceHtml: fixtureHtml });
    const fsMock = {
      promises: {
        readFile: vi.fn().mockResolvedValue(''),
        writeFile: vi.fn().mockResolvedValue(),
        mkdir: vi.fn().mockResolvedValue(),
      },
      existsSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
    };

    const report = await runSync(
      { sourceUrl: 'https://example.com/team' },
      { fetch: fetchFn, fs: fsMock, prisma }
    );

    expect(report.apply).toBe(false);
    expect(report.exactMatches).toBe(2);
    expect(report.uploaded.length).toBe(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(fsMock.promises.writeFile).not.toHaveBeenCalled();
  });

  it('applies updates for exact matches with no existing profileImage', async () => {
    const users = [
      { id: 'u1', fullName: 'Alice Smith', profileImage: null },
      { id: 'u2', fullName: 'Bob Jones', profileImage: null },
    ];
    const prisma = createPrisma(users);
    const fetchFn = vi.fn(async (url) => {
      if (typeof url === 'string' && url.includes('team')) {
        return createMockResponse({
          text: async () => applyFixtureHtml,
          headers: new Map([['content-type', 'text/html']]),
        });
      }
      return createMockResponse({
        arrayBuffer: async () => Buffer.from('image-data'),
        headers: new Map([['content-type', 'image/png']]),
      });
    });

    const report = await runSync(
      { sourceUrl: 'https://example.com/team', apply: true, overwrite: true, uploadDir: tmpDir },
      { fetch: fetchFn, prisma, now: () => 1, random: () => 0 }
    );

    expect(report.apply).toBe(true);
    expect(report.uploaded.length).toBe(2);
    expect(report.uploaded[0].verified).toBe(true);
    expect(report.uploaded[0].storedPath).toMatch(/^\/api\/uploads\/profile-images\/profile-1-0\.png$/);
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: expect.objectContaining({ profileImage: expect.stringContaining('/api/uploads/profile-images/') }),
      })
    );

    const storedPath = report.uploaded[0].storedPath;
    const filename = path.basename(storedPath);
    expect(fs.existsSync(path.join(tmpDir, filename))).toBe(true);
  });

  it('throws with a documented fallback when the source returns HTTP 406', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      createMockResponse({ ok: false, status: 406, statusText: 'Not Acceptable' })
    );
    await expect(
      runSync({ sourceUrl: 'https://example.com/team' }, { fetch: fetchFn })
    ).rejects.toThrow(/ModSecurity|406|--html-file/);
  });

  it('does not apply when source conflicts or ambiguous user matches exist', async () => {
    const users = [
      { id: 'u1', fullName: 'Alice Smith', profileImage: null },
      { id: 'u1dup', fullName: 'Alice Smith', profileImage: null }, // ambiguous
    ];
    const prisma = createPrisma(users);
    const fetchFn = createMockFetch({ sourceHtml: fixtureHtml });

    await expect(
      runSync(
        { sourceUrl: 'https://example.com/team', apply: true, uploadDir: tmpDir },
        { fetch: fetchFn, prisma }
      )
    ).rejects.toThrow(/Cannot apply/);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('reports skipped users when profileImage is already set and overwrite is false', async () => {
    const users = [
      { id: 'u1', fullName: 'Alice Smith', profileImage: '/api/uploads/profile-images/existing.png' },
      { id: 'u2', fullName: 'Bob Jones', profileImage: null },
    ];
    const prisma = createPrisma(users);
    const fetchFn = createMockFetch({ sourceHtml: fixtureHtml });

    const report = await runSync(
      { sourceUrl: 'https://example.com/team' },
      { fetch: fetchFn, prisma }
    );

    expect(report.skipped.length).toBe(1);
    expect(report.skipped[0].user.id).toBe('u1');
    expect(report.exactMatches).toBe(2);
  });
});
