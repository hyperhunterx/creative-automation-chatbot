// tests/setup/db.js
import { PrismaClient } from '@prisma/client';
import { it, describe } from 'vitest';

let prisma = null;

export function getTestPrisma() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. ' +
      'Set it to a Postgres URL with pgvector installed.'
    );
  }
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    });
  }
  return prisma;
}

export async function truncateProducts() {
  const db = getTestPrisma();
  await db.$executeRawUnsafe('TRUNCATE TABLE products RESTART IDENTITY CASCADE');
}

export async function disconnectTestPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

// Use these in integration-only tests. Unlike a name-prefix helper, these
// actually skip the test body — preventing getTestPrisma() from throwing on
// machines without INTEGRATION=1.
const isIntegration = process.env.INTEGRATION === '1';
export const integrationIt = it.skipIf(!isIntegration);
export const integrationDescribe = describe.skipIf(!isIntegration);
