import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isClaimSpecific } from './interviewSignups.js';

const prismaError = (code) =>
  new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: 'test' });

describe('isClaimSpecific', () => {
  it('retries a unique-index conflict claim by claim, since one claim caused it', () => {
    expect(isClaimSpecific(prismaError('P2002'))).toBe(true);
    expect(isClaimSpecific(prismaError('P2003'))).toBe(true);
  });

  it('fails the batch at once when the database is unreachable or overloaded', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']) {
      expect(isClaimSpecific(prismaError(code))).toBe(false);
    }
  });

  it('does not retry an error that is not a database refusal', () => {
    expect(isClaimSpecific(new Error('bug'))).toBe(false);
    expect(isClaimSpecific(new Prisma.PrismaClientUnknownRequestError('x', { clientVersion: 'test' }))).toBe(false);
  });
});
