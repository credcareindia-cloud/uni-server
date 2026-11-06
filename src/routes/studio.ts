import type { IncomingMessage, ServerResponse } from 'node:http'
import { Router } from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { handleAgentPost } from '../studio/estimationAgent.js'
import { handleStoreRequest } from '../studio/storeApi.js'

const OPENAI = 'https://api.openai.com'

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

async function proxyOpenAi(req: IncomingMessage, res: ServerResponse) {
  const apiKey = process.env.OPENAI_API_KEY || ''
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/^\/api\/openai/, '') || '/'
  if (!apiKey) {
    sendJson(res, 503, { error: 'OPENAI_API_KEY is not configured on the server' })
    return
  }
  req.setTimeout(600_000)
  res.setTimeout(600_000)
  if (path === '/ready' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, model: 'gpt-6.1-sol' })
    return
  }
  if ((path === '/files' || path === '/responses') && req.method === 'POST') {
    const body = await readBody(req)
    const upstream = await fetch(`${OPENAI}/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': req.headers['content-type'] || 'application/json',
      },
      body,
    })
    const text = await upstream.text()
    res.statusCode = upstream.status
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
    res.end(text)
    return
  }
  sendJson(res, 404, { error: `Unknown openai proxy path: ${path}` })
}

async function proxyAgent(req: IncomingMessage, res: ServerResponse) {
  await handleAgentPost(req, res, process.env.OPENAI_API_KEY || '')
}

export const studioRouter = Router()

studioRouter.use(authenticateToken)
studioRouter.use(async (req, res) => {
  try {
    const suffix = req.url || '/'
    if (suffix === '/agent' || suffix.startsWith('/agent?')) {
      await proxyAgent(req, res)
      return
    }
    if (suffix === '/openai' || suffix.startsWith('/openai/') || suffix.startsWith('/openai?')) {
      req.url = `/api${suffix}`
      await proxyOpenAi(req, res)
      return
    }
    req.url = `/api${suffix.startsWith('/') ? suffix : `/${suffix}`}`
    const handled = await handleStoreRequest(req, res)
    if (!handled) sendJson(res, 404, { error: 'Unknown estimate API path.' })
  } catch (error) {
    if (res.headersSent) return
    sendJson(res, 500, { error: error instanceof Error ? error.message : 'Estimate API failed' })
  }
})
