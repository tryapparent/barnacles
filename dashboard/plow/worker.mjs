const html = "__PLOW_HTML__"
const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}

export function sessionHistoryUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\.ts\.net(?::[0-9]{1,5})?\/sessions$/.test(value) || !URL.canParse(value)) return
  return new URL(value).href
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (url.hostname !== 'plow.tryapparent.com') return new Response(null, { status: 404 })
    if (url.pathname !== '/app' && url.pathname !== '/app/') return fetch(request)
    if (url.protocol !== 'https:') return Response.redirect('https://plow.tryapparent.com/app', 308)
    if (!env.PLOW_ACCESS_AUDIENCE || ctx.access?.aud !== env.PLOW_ACCESS_AUDIENCE) {
      return new Response('Cloudflare Access required', { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    }
    const destination = sessionHistoryUrl(env.PLOW_SESSION_HISTORY_URL)
    const content = destination ? html.replace('id="session-history-link" hidden', `id="session-history-link" href="${destination}"`) : html
    return new Response(request.method === 'HEAD' ? null : content, { headers })
  },
}
