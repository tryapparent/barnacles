const html = "__PLOW_HTML__"
const emptyFeed = '{"observed":0,"traces":[],"unavailable":true}'
const maxFeedLength = 128 * 1024
const headers = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
    try {
      const raw = await env.PLOW_SESSION_FEED?.get('session-timeline-v1')
      if (!raw || raw.length > maxFeedLength) throw Error('Feed unavailable')
      const feed = JSON.parse(raw)
      if (!Number.isSafeInteger(feed.observed) || !Array.isArray(feed.traces)) throw Error('Invalid feed')
      const payload = JSON.stringify(feed).replaceAll('<', '\\u003c')
      return new Response(request.method === 'HEAD' ? null : html.replace(emptyFeed, () => payload), { headers })
    } catch {
      return new Response(request.method === 'HEAD' ? null : html, { status: 503, headers })
    }
  },
}
