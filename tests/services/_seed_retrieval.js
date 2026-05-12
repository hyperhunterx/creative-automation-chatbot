import prisma from '../../app/db.server.js';

function vecLit(i) {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return `[${v.join(',')}]`;
}

const FIXTURES = [
  { id: 'gid://x/1', vendor: 'Festo',     category: 'Pneumatic Cylinder', title: 'Festo M20 cylinder',     desc: 'pneumatic cylinder bore 20mm', embIdx: 0 },
  { id: 'gid://x/2', vendor: 'SMC',       category: 'Pneumatic Cylinder', title: 'SMC M20 pneumatic cyl',  desc: 'pneumatic cylinder bore 20mm', embIdx: 0 },
  { id: 'gid://x/3', vendor: 'Norgren',   category: 'Pneumatic Cylinder', title: 'Norgren cyl 20mm',       desc: 'pneumatic cylinder',           embIdx: 0 },
  { id: 'gid://x/4', vendor: 'Festo',     category: 'Pressure Gauge',     title: 'Festo PG-100 gauge',     desc: 'pressure gauge analog',        embIdx: 1 },
  { id: 'gid://x/5', vendor: 'ABB',       category: 'Circuit Breaker',    title: 'ABB MCB 16A',            desc: 'miniature circuit breaker',    embIdx: 2 },
  { id: 'gid://x/6', vendor: 'Schneider', category: 'Pneumatic Cylinder', title: 'Schneider cyl PCM-20',   desc: 'pneumatic cylinder M20',       embIdx: 0 },
];

export async function seedFixtures() {
  for (const f of FIXTURES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO products (id, handle, title, vendor, "productType", category, description, embedding, "indexedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      f.id,
      f.id.replace(/[^a-z0-9]/gi, '-').toLowerCase(),
      f.title,
      f.vendor,
      f.category,
      f.category,
      f.desc,
      vecLit(f.embIdx),
    );
  }
}
