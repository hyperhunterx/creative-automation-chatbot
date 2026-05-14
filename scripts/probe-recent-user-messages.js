// scripts/probe-recent-user-messages.js
// Shows the most recent user-side messages across all conversations.
// Read-only.

import 'dotenv/config';
import prisma from '../app/db.server.js';

const LIMIT = Number(process.argv[2]) || 40;

console.log(`=== Q1: Counts ===`);
const counts = await prisma.$queryRawUnsafe(`
  SELECT
    (SELECT count(*) FROM "Conversation")::int AS conversations,
    (SELECT count(*) FROM "Message")::int       AS messages_total,
    (SELECT count(*) FROM "Message" WHERE role = 'user')::int AS messages_user,
    (SELECT count(*) FROM "Message" WHERE role = 'user' AND "createdAt" > now() - interval '24 hours')::int AS user_msgs_24h
`);
console.log(JSON.stringify(counts[0], null, 2));

console.log(`\n=== Q2: Last ${LIMIT} user messages (most recent first) ===`);
const rows = await prisma.$queryRawUnsafe(
  `
  SELECT
    m."createdAt",
    m."conversationId",
    m.content,
    c.status,
    c."messageCount"
  FROM "Message" m
  JOIN "Conversation" c ON c.id = m."conversationId"
  WHERE m.role = 'user'
  ORDER BY m."createdAt" DESC
  LIMIT $1
`,
  LIMIT,
);

for (const r of rows) {
  const time = r.createdAt.toISOString().replace('T', ' ').slice(0, 19);
  const text = (r.content || '').replace(/\s+/g, ' ').slice(0, 120);
  const convo = r.conversationId.slice(0, 12);
  console.log(`  ${time}  convo=${convo}  msgs=${r.messageCount}  ${r.status.padEnd(8)}  ${text}`);
}

await prisma.$disconnect();
