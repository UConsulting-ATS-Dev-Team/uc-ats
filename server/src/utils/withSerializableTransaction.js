import { Prisma } from '@prisma/client';

const RETRYABLE_CODES = new Set(['P2034', 'P2024']);

export class SlotTransactionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'SlotTransactionError';
  }
}

export async function withSerializableTransaction(prisma, fn, options = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 50;
  const timeout = options.timeout ?? 10000;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: 'Serializable',
        timeout,
      });
    } catch (error) {
      lastError = error;
      const code =
        error?.code ||
        (error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null);
      if (!RETRYABLE_CODES.has(code) || attempt === maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
