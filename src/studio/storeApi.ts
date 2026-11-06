import type { IncomingMessage, ServerResponse } from 'node:http'
import { query } from './db.js'

const ID = /^[A-Za-z0-9_-]{1,80}$/

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(json)
}

function counts(body: unknown) {
  const row = body && typeof body === 'object' ? (body as { lines?: unknown; documents?: unknown }) : {}
  return {
    lineCount: Array.isArray(row.lines) ? row.lines.length : 0,
    fileCount: Array.isArray(row.documents) ? row.documents.length : 0,
  }
}

/** Project, drawing, foundation and price-sheet API. Returns false when the path is not ours. */
export async function handleStoreRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (!path.startsWith('/api/')) return false
  if (path.startsWith('/api/openai') || path === '/api/agent') return false

  try {
    const parts = path.split('/').filter(Boolean)

    if (path === '/api/health' && req.method === 'GET') {
      await query('SELECT 1')
      send(res, 200, { ok: true })
      return true
    }

    if (path === '/api/price-sheet' && req.method === 'GET') {
      const result = await query('SELECT rows FROM price_sheet WHERE id = $1', ['default'])
      send(res, 200, result.rows[0]?.rows ?? null)
      return true
    }
    if (path === '/api/price-sheet' && req.method === 'PUT') {
      const rows = JSON.parse((await readBody(req)).toString('utf8'))
      if (!Array.isArray(rows)) {
        send(res, 400, { error: 'Price sheet must be a list.' })
        return true
      }
      await query(
        `INSERT INTO price_sheet (id, rows, updated_at) VALUES ('default', $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET rows = EXCLUDED.rows, updated_at = now()`,
        [JSON.stringify(rows)],
      )
      send(res, 200, { ok: true })
      return true
    }

    if (path === '/api/package-register' && req.method === 'GET') {
      const result = await query('SELECT state FROM package_register WHERE id = $1', ['default'])
      send(res, 200, result.rows[0]?.state ?? null)
      return true
    }
    if (path === '/api/package-register' && req.method === 'PUT') {
      const state = JSON.parse((await readBody(req)).toString('utf8'))
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        send(res, 400, { error: 'Package register must be an object.' })
        return true
      }
      await query(
        `INSERT INTO package_register (id, state, updated_at) VALUES ('default', $1::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [JSON.stringify(state)],
      )
      send(res, 200, { ok: true })
      return true
    }

    if (path === '/api/projects' && req.method === 'GET') {
      const result = await query('SELECT id, name, created_at, updated_at, body FROM projects ORDER BY updated_at DESC')
      send(
        res,
        200,
        result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
          ...counts(row.body),
        })),
      )
      return true
    }

    const projectId = parts[2]
    if (parts[0] !== 'api' || parts[1] !== 'projects' || !projectId || !ID.test(projectId)) {
      send(res, 404, { error: 'Unknown API path.' })
      return true
    }

    if (parts.length === 3 && req.method === 'GET') {
      const result = await query('SELECT id, name, created_at, updated_at, body FROM projects WHERE id = $1', [projectId])
      const row = result.rows[0]
      if (!row) {
        send(res, 404, { error: 'Project not found.' })
        return true
      }
      const files = await query('SELECT doc_id, size FROM project_files WHERE project_id = $1', [projectId])
      send(res, 200, {
        id: row.id,
        name: row.name,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        body: row.body,
        files: files.rows.map((file) => ({ docId: file.doc_id, size: file.size })),
      })
      return true
    }

    if (parts.length === 3 && req.method === 'PUT') {
      const payload = JSON.parse((await readBody(req)).toString('utf8')) as {
        name?: string
        createdAt?: string
        updatedAt?: string
        body?: unknown
        fileIds?: string[]
      }
      if (!payload.name || !payload.body || typeof payload.body !== 'object') {
        send(res, 400, { error: 'Project name and body are required.' })
        return true
      }
      const createdAt = payload.createdAt || new Date().toISOString()
      const updatedAt = payload.updatedAt || new Date().toISOString()
      await query(
        `INSERT INTO projects (id, name, created_at, updated_at, body) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at, body = EXCLUDED.body`,
        [projectId, payload.name, createdAt, updatedAt, JSON.stringify(payload.body)],
      )
      const listed = Array.isArray((payload.body as { documents?: unknown }).documents)
        ? ((payload.body as { documents: Array<{ id?: string }> }).documents)
            .map((doc) => doc?.id)
            .filter((id): id is string => typeof id === 'string' && ID.test(id))
        : []
      const keep = [...new Set([...(payload.fileIds ?? []).filter((id) => ID.test(id)), ...listed])]
      await query('DELETE FROM project_files WHERE project_id = $1 AND NOT (doc_id = ANY($2::text[]))', [projectId, keep])
      const stored = keep.length
        ? await query('SELECT doc_id FROM project_files WHERE project_id = $1 AND doc_id = ANY($2::text[])', [projectId, keep])
        : { rows: [] as Array<{ doc_id: string }> }
      const have = new Set(stored.rows.map((row) => String(row.doc_id)))
      const missingFileIds = (payload.fileIds ?? []).filter((id) => ID.test(id) && !have.has(id))
      send(res, 200, { ok: true, missingFileIds })
      return true
    }

    if (parts.length === 3 && req.method === 'DELETE') {
      await query('DELETE FROM foundation_engine WHERE project_id = $1', [projectId])
      await query('DELETE FROM superstructure_engine WHERE project_id = $1', [projectId])
      await query('DELETE FROM architecture_engine WHERE project_id = $1', [projectId])
      await query('DELETE FROM mep_engine WHERE project_id = $1', [projectId])
      await query('DELETE FROM dry_cost WHERE project_id = $1', [projectId])
      await query('DELETE FROM foundation_chat WHERE project_id = $1', [projectId])
      await query('DELETE FROM plan_chat WHERE project_id = $1', [projectId])
      await query('DELETE FROM projects WHERE id = $1', [projectId])
      send(res, 200, { ok: true })
      return true
    }

    const docId = parts[4]
    if (parts[3] === 'files' && docId && ID.test(docId) && parts.length === 5) {
      if (req.method === 'GET') {
        const result = await query('SELECT bytes FROM project_files WHERE project_id = $1 AND doc_id = $2', [projectId, docId])
        const bytes = result.rows[0]?.bytes as Buffer | undefined
        if (!bytes) {
          send(res, 404, { error: 'File not found.' })
          return true
        }
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/pdf')
        res.end(bytes)
        return true
      }
      if (req.method === 'PUT') {
        const bytes = await readBody(req)
        if (!bytes.length) {
          send(res, 400, { error: 'Empty file.' })
          return true
        }
        await query(
          `INSERT INTO project_files (project_id, doc_id, bytes, size) VALUES ($1, $2, $3, $4)
           ON CONFLICT (project_id, doc_id) DO UPDATE SET bytes = EXCLUDED.bytes, size = EXCLUDED.size`,
          [projectId, docId, bytes, bytes.length],
        )
        send(res, 200, { ok: true, size: bytes.length })
        return true
      }
    }

    if (parts[3] === 'engine' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT state FROM foundation_engine WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.state ?? null)
        return true
      }
      if (req.method === 'PUT') {
        const state = JSON.parse((await readBody(req)).toString('utf8'))
        await query(
          `INSERT INTO foundation_engine (project_id, state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [projectId, JSON.stringify(state)],
        )
        send(res, 200, { ok: true })
        return true
      }
    }

    if (parts[3] === 'architecture' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT state FROM architecture_engine WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.state ?? null)
        return true
      }
      if (req.method === 'PUT') {
        const state = JSON.parse((await readBody(req)).toString('utf8'))
        await query(
          `INSERT INTO architecture_engine (project_id, state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [projectId, JSON.stringify(state)],
        )
        send(res, 200, { ok: true })
        return true
      }
    }

    if (parts[3] === 'mep' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT state FROM mep_engine WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.state ?? null)
        return true
      }
      if (req.method === 'PUT') {
        const state = JSON.parse((await readBody(req)).toString('utf8'))
        await query(
          `INSERT INTO mep_engine (project_id, state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [projectId, JSON.stringify(state)],
        )
        send(res, 200, { ok: true })
        return true
      }
    }

    if (parts[3] === 'dry-cost' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT state FROM dry_cost WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.state ?? null)
        return true
      }
      if (req.method === 'PUT') {
        const state = JSON.parse((await readBody(req)).toString('utf8'))
        await query(
          `INSERT INTO dry_cost (project_id, state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [projectId, JSON.stringify(state)],
        )
        send(res, 200, { ok: true })
        return true
      }
    }

    if (parts[3] === 'superstructure' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT state FROM superstructure_engine WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.state ?? null)
        return true
      }
      if (req.method === 'PUT') {
        const state = JSON.parse((await readBody(req)).toString('utf8'))
        await query(
          `INSERT INTO superstructure_engine (project_id, state, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [projectId, JSON.stringify(state)],
        )
        send(res, 200, { ok: true })
        return true
      }
    }

    if (parts[3] === 'plan-chat' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT messages FROM plan_chat WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.messages ?? [])
        return true
      }
      if (req.method === 'PUT') {
        const messages = JSON.parse((await readBody(req)).toString('utf8'))
        if (!Array.isArray(messages)) {
          send(res, 400, { error: 'Chat must be a list of messages.' })
          return true
        }
        await query(
          `INSERT INTO plan_chat (project_id, messages, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
          [projectId, JSON.stringify(messages)],
        )
        send(res, 200, { ok: true })
        return true
      }
      if (req.method === 'DELETE') {
        await query('DELETE FROM plan_chat WHERE project_id = $1', [projectId])
        send(res, 200, { ok: true })
        return true
      }
    }

    if (parts[3] === 'foundation-chat' && parts.length === 4) {
      if (req.method === 'GET') {
        const result = await query('SELECT messages FROM foundation_chat WHERE project_id = $1', [projectId])
        send(res, 200, result.rows[0]?.messages ?? [])
        return true
      }
      if (req.method === 'PUT') {
        const messages = JSON.parse((await readBody(req)).toString('utf8'))
        if (!Array.isArray(messages)) {
          send(res, 400, { error: 'Chat must be a list of messages.' })
          return true
        }
        await query(
          `INSERT INTO foundation_chat (project_id, messages, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (project_id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
          [projectId, JSON.stringify(messages)],
        )
        send(res, 200, { ok: true })
        return true
      }
      if (req.method === 'DELETE') {
        await query('DELETE FROM foundation_chat WHERE project_id = $1', [projectId])
        send(res, 200, { ok: true })
        return true
      }
    }

    send(res, 404, { error: 'Unknown API path.' })
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database error'
    const down = /ECONNREFUSED|ENOTFOUND|password authentication|does not exist|DATABASE_URL/.test(message)
    send(res, down ? 503 : 500, {
      error: down ? 'Estimate database is not reachable.' : message,
    })
    return true
  }
}
