import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | null = null
let ready: Promise<void> | null = null

const TABLES = /(?<!estimation\.)\b(project_files|foundation_engine|foundation_chat|superstructure_engine|architecture_engine|mep_engine|plan_chat|price_sheet|dry_cost|package_register|projects)\b/g

function qualify(text: string) {
  return text.replace(TABLES, 'estimation.$1')
}

export function getPool() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  if (!pool) pool = new Pool({ connectionString: url, max: 6 })
  return pool
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS estimation;
CREATE TABLE IF NOT EXISTS estimation.projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS estimation.project_files (
  project_id text NOT NULL REFERENCES estimation.projects(id) ON DELETE CASCADE,
  doc_id text NOT NULL,
  bytes bytea NOT NULL,
  size integer NOT NULL,
  PRIMARY KEY (project_id, doc_id)
);
CREATE TABLE IF NOT EXISTS estimation.foundation_engine (
  project_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.foundation_chat (
  project_id text PRIMARY KEY,
  messages jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.superstructure_engine (
  project_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.architecture_engine (
  project_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.mep_engine (
  project_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.plan_chat (
  project_id text PRIMARY KEY,
  messages jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.dry_cost (
  project_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.package_register (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS estimation.price_sheet (
  id text PRIMARY KEY,
  rows jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`

export function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      const client = await getPool().connect()
      try {
        for (const statement of SCHEMA.split(';').map((part) => part.trim()).filter(Boolean)) {
          await client.query(statement)
        }
      } finally {
        client.release()
      }
    })().catch((error) => {
      ready = null
      throw error
    })
  }
  return ready
}

export async function query(text: string, params?: unknown[]) {
  await ensureSchema()
  return getPool().query(qualify(text), params)
}
