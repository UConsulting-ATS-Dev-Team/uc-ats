import { describe, it, expect } from 'vitest';
import { headshotSrc } from './headshotUrl';

describe('headshotSrc', () => {
  it('asks for the 256 px copy for a list avatar', () => {
    expect(headshotSrc('/api/files/abc/image', 40)).toBe('/api/files/abc/image?size=256');
    // 64 px at 3x is 192: still the small one.
    expect(headshotSrc('/api/files/abc/image', 64)).toBe('/api/files/abc/image?size=256');
  });

  it('asks for the 640 px copy for a large circle', () => {
    expect(headshotSrc('/api/files/abc/image', 120)).toBe('/api/files/abc/image?size=640');
    expect(headshotSrc('/api/files/abc/image', 180)).toBe('/api/files/abc/image?size=640');
  });

  it('keeps the original when it is shown bigger than any copy', () => {
    expect(headshotSrc('/api/files/abc/image', 400)).toBe('/api/files/abc/image');
  });

  it('drops a baked-in origin, so the preload and the avatar agree on one URL', () => {
    expect(headshotSrc('https://uconsultingats.com/api/files/abc/image', 40)).toBe('/api/files/abc/image?size=256');
  });

  it('leaves anything that is not our image route alone', () => {
    const drive = 'https://drive.google.com/open?id=abc';
    expect(headshotSrc(drive, 40)).toBe(drive);
    expect(headshotSrc('/api/files/abc/pdf', 40)).toBe('/api/files/abc/pdf');
    expect(headshotSrc('', 40)).toBe('');
    expect(headshotSrc(null, 40)).toBe(null);
  });
});
