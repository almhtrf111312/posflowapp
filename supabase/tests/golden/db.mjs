// Golden-case harness (docs/FINANCE_LAW.md, KD-03): replays supabase/migrations in their REAL applied order
// (scripts/migration-order.json) into an in-memory PGlite Postgres, with minimal stand-ins for the Supabase
// environment (roles, auth.uid(), storage, net, cron). Nothing here touches any real database.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MIG = path.join(REPO, 'supabase/migrations');
const ORDER = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/migration-order.json'), 'utf8')).applied_version_by_slug;
const EXCLUDE = new Set(['20261123060000_performance_indexes.sql']); // not applied on the live database
const effKey = (f) => `${ORDER[f.replace(/^\d{14}_/, '')] ?? f.slice(0, 14)}|${f}`;

export function splitSql(sql) {
  const out = []; let cur = ''; let i = 0; const n = sql.length;
  let dollar = null, inS = false, inD = false, inLine = false, block = 0;
  while (i < n) {
    const c = sql[i], c2 = sql[i + 1];
    if (inLine) { cur += c; if (c === '\n') inLine = false; i++; continue; }
    if (block) { cur += c; if (c === '*' && c2 === '/') { cur += c2; i += 2; block--; continue; } if (c === '/' && c2 === '*') { cur += c2; i += 2; block++; continue; } i++; continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; } cur += c; i++; continue; }
    if (inS) { cur += c; if (c === "'" && c2 === "'") { cur += c2; i += 2; continue; } if (c === "'") inS = false; i++; continue; }
    if (inD) { cur += c; if (c === '"') inD = false; i++; continue; }
    if (c === '-' && c2 === '-') { inLine = true; cur += c; i++; continue; }
    if (c === '/' && c2 === '*') { block = 1; cur += '/*'; i += 2; continue; }
    if (c === "'") { inS = true; cur += c; i++; continue; }
    if (c === '"') { inD = true; cur += c; i++; continue; }
    if (c === '$') { const m = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i, i + 64)); if (m) { dollar = m[0]; cur += dollar; i += dollar.length; continue; } }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const PREAMBLE = `
set check_function_bodies = off;
do $$ begin
  create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticator nologin; exception when duplicate_object then null; end $$;
do $$ begin create role supabase_admin nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth; create schema if not exists extensions; create schema if not exists storage;
create schema if not exists vault; create schema if not exists net; create schema if not exists cron; create schema if not exists graphql_public;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text, encrypted_password text,
  raw_user_meta_data jsonb default '{}'::jsonb, raw_app_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now(),
  updated_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz, banned_until timestamptz);
create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid, created_at timestamptz default now());
create table auth.refresh_tokens (id bigserial primary key, user_id text, revoked boolean default false, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 1000) returns bigint language sql as $$ select 1::bigint $$;
create function cron.schedule(a text, b text, c text) returns bigint language sql as $$ select 1::bigint $$;
create function cron.schedule(a text, b text) returns bigint language sql as $$ select 1::bigint $$;
create function cron.unschedule(a text) returns boolean language sql as $$ select true $$;
create publication supabase_realtime;
`;

export async function buildDb({ log = true } = {}) {
  const db = new PGlite();
  await db.exec(PREAMBLE);
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql') && !EXCLUDE.has(f)).sort((a, b) => effKey(a.slice(0, -4)).localeCompare(effKey(b.slice(0, -4))));
  const errors = new Map(); let ok = 0, failed = 0;
  for (const f of files) {
    const stmts = splitSql(fs.readFileSync(path.join(MIG, f), 'utf8'));
    for (const st of stmts) {
      const head = st.replace(/^(\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*/, '').slice(0, 40).toUpperCase();
      if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/.test(head) || /^CREATE EXTENSION/.test(head)) continue;
      try { await db.exec(st); ok++; } catch (e) {
        failed++;
        const key = String(e.message).slice(0, 110);
        const rec = errors.get(key) || { n: 0, files: new Set(), sample: st.slice(0, 90).replace(/\s+/g, ' ') };
        rec.n++; rec.files.add(f.slice(0, 22)); errors.set(key, rec);
      }
    }
  }
  if (log) console.log(`replayed ${files.length} files: ${ok} statements ok, ${failed} failed`);
  return { db, errors, files };
}
