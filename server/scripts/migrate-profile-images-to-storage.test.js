import { describe, it, expect } from 'vitest';
import { planMigration } from './migrate-profile-images-to-storage.js';

const committed = new Set(['profile-1785085416663-280384046.png']);
const exists = (name) => committed.has(name);

describe('planMigration', () => {
  it('uploads a committed team photo and clears one uploaded through the app', () => {
    const plan = planMigration(
      [
        { id: 'a', fullName: 'Team Photo', profileImage: '/api/uploads/profile-images/profile-1785085416663-280384046.png' },
        { id: 'b', fullName: 'Wiped Upload', profileImage: '/api/uploads/profile-images/profile-1790263029424-811464201.png' },
      ],
      exists
    );
    expect(plan.upload.map((u) => [u.id, u.fileName])).toEqual([['a', 'profile-1785085416663-280384046.png']]);
    expect(plan.clear.map((u) => u.id)).toEqual(['b']);
  });

  it('leaves rows already in storage, or with no image, untouched', () => {
    const plan = planMigration(
      [
        { id: 'a', fullName: 'Stored', profileImage: 'https://proj.supabase.co/storage/v1/object/public/profile-images/a/1.jpg' },
        { id: 'b', fullName: 'None', profileImage: null },
      ],
      exists
    );
    expect(plan.skip.map((u) => u.id)).toEqual(['a', 'b']);
    expect(plan.upload).toEqual([]);
    expect(plan.clear).toEqual([]);
  });

  it('treats a path that escapes the upload directory as missing', () => {
    const plan = planMigration(
      [{ id: 'a', fullName: 'Odd', profileImage: '/api/uploads/profile-images/../../.env' }],
      () => true
    );
    expect(plan.clear.map((u) => u.id)).toEqual(['a']);
  });
});
