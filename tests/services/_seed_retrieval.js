import prisma from '../../app/db.server.js';

function vecLit(i) {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return `[${v.join(',')}]`;
}

// All filterable fields are stored normalized (lowercase). Display fields
// (vendor, productType) keep original casing.
const FIXTURES = [
  { id: 'gid://x/1', vendor: 'Festo',     vendorNormalized: 'festo',     categories: ['pneumatic cylinders'], title: 'Festo M20 cylinder',     desc: 'pneumatic cylinder bore 20mm', embIdx: 0, specs: { Type: '5/2', 'Country of Origin': 'Germany' } },
  { id: 'gid://x/2', vendor: 'SMC',       vendorNormalized: 'smc',       categories: ['pneumatic cylinders'], title: 'SMC M20 pneumatic cyl',  desc: 'pneumatic cylinder bore 20mm', embIdx: 0, specs: { Type: '3/2', 'Country of Origin': 'Japan' } },
  { id: 'gid://x/3', vendor: 'Norgren',   vendorNormalized: 'norgren',   categories: ['pneumatic cylinders'], title: 'Norgren cyl 20mm',       desc: 'pneumatic cylinder',           embIdx: 0, specs: {} },
  { id: 'gid://x/4', vendor: 'Festo',     vendorNormalized: 'festo',     categories: ['pressure gauges'],     title: 'Festo PG-100 gauge',     desc: 'pressure gauge analog',        embIdx: 1, specs: { 'Country of Origin': 'Germany' } },
  { id: 'gid://x/5', vendor: 'ABB',       vendorNormalized: 'abb',       categories: ['circuit breakers'],    title: 'ABB MCB 16A',            desc: 'miniature circuit breaker',    embIdx: 2, specs: { Amperage: '16A' } },
  { id: 'gid://x/6', vendor: 'Schneider', vendorNormalized: 'schneider', categories: ['pneumatic cylinders'], title: 'Schneider cyl PCM-20',   desc: 'pneumatic cylinder M20',       embIdx: 0, specs: { Type: '5/2' } },
  // Catalog uses long granular category names — searching "solenoid valves" must
  // substring-match "pneumatic solenoid valves" and "solenoid valve accessories"
  // since the real Shopify catalog has only 6 rows literal-equal to "solenoid valves".
  { id: 'gid://x/7', vendor: 'Waircom',   vendorNormalized: 'waircom',   categories: ['pneumatic solenoid valves', 'pneumatics & hydraulics'], title: 'Waircom 5/2 solenoid valve', desc: 'pneumatic 5/2 valve',     embIdx: 0, specs: {} },
  { id: 'gid://x/8', vendor: 'SMC',       vendorNormalized: 'smc',       categories: ['solenoid valve accessories'],                            title: 'SMC SY5120 solenoid valve',  desc: '3/2 way valve',           embIdx: 0, specs: {} },
];

export async function seedFixtures() {
  for (const f of FIXTURES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO products (id, handle, title, vendor, "vendorNormalized", "productType", category, categories, description, specs, embedding, "indexedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::vector, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      f.id,
      f.id.replace(/[^a-z0-9]/gi, '-').toLowerCase(),
      f.title,
      f.vendor,
      f.vendorNormalized,
      f.categories[0],
      f.categories[0],
      f.categories,
      f.desc,
      JSON.stringify(f.specs || {}),
      vecLit(f.embIdx),
    );
  }
}
