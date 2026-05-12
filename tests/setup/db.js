// tests/setup/db.js
import { PrismaClient } from '@prisma/client';

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

export function skipIfNotIntegration(name) {
  return process.env.INTEGRATION === '1' ? name : `${name} [SKIPPED — set INTEGRATION=1]`;
}
