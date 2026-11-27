import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const html = "__PLOW_HTML__"
const emptyFeed = '{"observed":0,"traces":[],"unavailable":true}'
const maxFeedLength = 132 * 1024
const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}

export function analysisApiUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\.ts\.net(?::[0-9]{1,5})?\/api\/v1\/bottlenecks$/.test(value) || !URL.canParse(value)) return
  return new URL(value)
}

export function feedPayload(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maxFeedLength) throw Error('Feed unavailable')
  const feed = JSON.parse(raw)
  if (!Number.isSafeInteger(feed.observed) || !Array.isArray(feed.traces)) throw Error('Invalid feed')
  return JSON.stringify(feed).replaceAll('<', '\\u003c')
}

export function accessVerifier(jwtVerify, keys, issuer, audience) {
  return async token => {
    if (typeof token !== 'string' || !token) return false
    try {
      await jwtVerify(token, keys, { algorithms: ['RS256'], issuer, audience, requiredClaims: ['exp'] })
      return true
    } catch {
      return false
    }
  }
}

export function managedOAuth(previous, callback) {
  const next = { ...previous, enabled: true }
  if (!callback) return next
  const url = new URL(callback)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || callback.includes('*')) {
    throw Error('Expected an exact HTTPS redirect URI from the hosted MCP client.')
  }
  const registration = next.dynamic_client_registration
  return { ...next, dynamic_client_registration: {
    ...registration, enabled: true, allowed_uris: [...new Set([...(registration?.allowed_uris ?? []), callback])],
  } }
}

export async function checkOAuthChallenge(endpoint) {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  })
  await response.body?.cancel()
  if (response.status !== 401 || !/\bresource_metadata=/i.test(response.headers.get('www-authenticate') ?? '')) {
    throw Error('Cloudflare did not return MCP OAuth discovery.')
  }
}

export function createDashboardServer({ getFeed, verifyToken, analysisApi, revision }) {
  const api = analysisApiUrl(analysisApi)
  const content = api ? html.replace('data-analysis-api=""', `data-analysis-api="${api.href}"`) : html
  const pageHeaders = api ? { ...headers, 'Content-Security-Policy':
    `${headers['Content-Security-Policy']}; connect-src ${api.origin}` } : headers
  return createServer(async (request, response) => {
    const reply = (status, body, additional = {}) => {
      response.writeHead(status, { ...headers, ...additional })
      response.end(request.method === 'HEAD' ? undefined : body)
    }
    const path = request.url?.split('?', 1)[0]
    if (request.method === 'GET' && path === '/_health') {
      try {
        await feedPayload(await getFeed())
        return reply(204)
      } catch {
        return reply(503)
      }
    }
    if (path !== '/app' && path !== '/app/') return reply(404)
    if (!(await verifyToken(request.headers['cf-access-jwt-assertion']))) return reply(403, 'Cloudflare Access required')
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405, undefined, { Allow: 'GET, HEAD' })
    const release = { ...pageHeaders, 'X-Plow-Revision': revision }
    try {
      const payload = await feedPayload(await getFeed())
      reply(200, content.replace(emptyFeed, () => payload), release)
    } catch {
      reply(503, content, release)
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose')
  const { PLOW_ACCESS_TEAM, PLOW_ACCESS_AUDIENCE, PLOW_RELEASE, PLOW_ANALYSIS_API_URL } = process.env
  if (!/^[a-z0-9-]+$/.test(PLOW_ACCESS_TEAM ?? '') || !/^[a-f0-9]{64}$/.test(PLOW_ACCESS_AUDIENCE ?? '') ||
      !/^[a-f0-9]{40}$/.test(PLOW_RELEASE ?? '') ||
      (PLOW_ANALYSIS_API_URL && !analysisApiUrl(PLOW_ANALYSIS_API_URL))) {
    throw Error('Invalid Plow Access, release, or private URL configuration')
  }
  const issuer = `https://${PLOW_ACCESS_TEAM}.cloudflareaccess.com`
  const keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer))
  createDashboardServer({
    getFeed: () => readFile('/feed/timeline.json', 'utf8'),
    verifyToken: accessVerifier(jwtVerify, keys, issuer, PLOW_ACCESS_AUDIENCE),
    analysisApi: PLOW_ANALYSIS_API_URL,
    revision: PLOW_RELEASE,
  }).listen(8080, '0.0.0.0')
}
