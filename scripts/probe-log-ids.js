// Quick: hand it a list of Shopify Product GIDs, get back titles + vendors.
import 'dotenv/config';
import prisma from '../app/db.server.js';

const groups = [
  { turn: 'T2 (search, normal)',  ids: ['gid://shopify/Product/8580847141001','gid://shopify/Product/8580846813321','gid://shopify/Product/8580846944393'] },
  { turn: 'T4 (slash-spec boost)', ids: ['gid://shopify/Product/8240137666697','gid://shopify/Product/8240138223753','gid://shopify/Product/8240139600009'] },
  { turn: 'T5 (search, normal)',  ids: ['gid://shopify/Product/8251135197321','gid://shopify/Product/8251135590537','gid://shopify/Product/8251091648649'] },
  { turn: 'T6 (cat-relaxed, SKU-filtered)', ids: ['gid://shopify/Product/8127507169417','gid://shopify/Product/8394941137033','gid://shopify/Product/8394940842121'] },
];

for (const g of groups) {
  console.log(`\n=== ${g.turn} ===`);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, title, vendor, "priceMin", currency FROM products WHERE id = ANY($1::text[])`,
    g.ids,
  );
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  for (const id of g.ids) {
    const r = byId[id];
    if (!r) { console.log(`  MISSING  ${id}`); continue; }
    console.log(`  ${(r.vendor || '').padEnd(14)} ${String(r.priceMin ?? '').padStart(7)} ${r.currency || ''}  ${r.title}`);
  }
}
await prisma.$disconnect();
