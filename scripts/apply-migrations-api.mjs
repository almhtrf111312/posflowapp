// يطبّق ملفات supabase/migrations على مشروع Supabase عبر Management API (HTTPS 443)
// الاستعمال (PowerShell):
//   $env:SUPABASE_ACCESS_TOKEN = "sbp_..."     # Personal Access Token من حسابك
//   node scripts/apply-migrations-api.mjs bwlqfxfvchjvehnbvwaz
// يتوقف عند أول خطأ، ويسجّل كل migration ناجح في supabase_migrations.schema_migrations
// ليتعرّف عليه Supabase CLI لاحقاً. آمن لإعادة التشغيل (يتخطى المطبّق).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ref = process.argv[2];
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!ref || !token) {
  console.error('الاستعمال: node scripts/apply-migrations-api.mjs <project-ref>  (مع SUPABASE_ACCESS_TOKEN)');
  process.exit(2);
}
const API = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const dir = join(process.cwd(), 'supabase', 'migrations');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(query, attempt = 1) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  } catch (e) {
    if (attempt < 4) { await sleep(2000 * attempt); return run(query, attempt + 1); }
    throw new Error('فشل الاتصال بالشبكة: ' + e.message);
  }
  if (res.status === 429 && attempt < 6) { await sleep(5000 * attempt); return run(query, attempt + 1); }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 1500)}`);
  try { return JSON.parse(text); } catch { return text; }
}

await run(`create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`);

const applied = new Set(
  (await run('select version from supabase_migrations.schema_migrations')).map((r) => r.version)
);

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let done = 0, skipped = 0;
for (const f of files) {
  const m = f.match(/^(\d+)_(.*)\.sql$/);
  if (!m) { console.log('تخطي (اسم غير معتاد):', f); continue; }
  const [, version, name] = m;
  if (applied.has(version)) { skipped++; continue; }
  const sql = readFileSync(join(dir, f), 'utf8').replace(/^﻿/, '');
  const record = `\n;\ninsert into supabase_migrations.schema_migrations(version, name, statements) values ('${version}', '${name.replace(/'/g, "''")}', array[]::text[]) on conflict do nothing;`;
  process.stdout.write(`[${done + skipped + 1}/${files.length}] ${f} ... `);
  try {
    await run(sql + record);
    console.log('OK');
    done++;
  } catch (e) {
    console.log('فشل');
    console.error('\nالملف:', f, '\n', e.message);
    process.exit(1);
  }
  await sleep(600);
}
console.log(`\nانتهى. طُبّق ${done}، تُخطّي ${skipped}.`);
