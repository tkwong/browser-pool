// Per-pod control plane sidecar for chrome-vnc.
//
// Runs in the SAME pod as chromium, shares network namespace. Talks to
// chromium over the cdp-relay nginx (localhost:9223 → chromium 127.0.0.1:9222).
// We deliberately do NOT share PID namespace because linuxserver/chromium's
// s6-overlay refuses to run unless it is PID 1.
//
// API:
//   GET  /healthz         → { ok: true }
//   GET  /status          → { chromium_alive, cookie_count, target_count, last_wipe_at }
//   POST /wipe            → CDP-clear cookies/storage + close non-blank tabs
//   POST /dump-profile    body: {domain_filter?: "facebook.com"}
//                         → { schema, saved_at, cookies, origins[{origin, localStorage}] }
//   POST /inject-profile  body: profile JSON (same shape dump produces)
//                         → { injected, cookies, origins }

import http from 'node:http'

const PORT     = parseInt(process.env.CONTROL_PORT || '9224', 10)
const CDP_BASE = process.env.CDP_BASE || 'http://localhost:9223'
const HOMEPAGE = process.env.HOMEPAGE_URL || 'about:blank'

let lastWipe = null

// --- tiny CDP client over Node 22+ built-in global WebSocket --- //
function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl)
  const pending = new Map()
  const eventListeners = new Map()      // method → [handlers]
  let id = 0
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`))
      else resolve(msg.result)
    } else if (msg.method && eventListeners.has(msg.method)) {
      for (const fn of eventListeners.get(msg.method)) fn(msg.params)
    }
  })
  ws.addEventListener('error', () => {})
  const opened = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  return {
    ready: opened,
    send(method, params = {}) {
      const myId = ++id
      const promise = new Promise((resolve, reject) => pending.set(myId, { resolve, reject }))
      ws.send(JSON.stringify({ id: myId, method, params }))
      return promise
    },
    on(method, fn) {
      if (!eventListeners.has(method)) eventListeners.set(method, [])
      eventListeners.get(method).push(fn)
    },
    close() { try { ws.close() } catch {} },
  }
}

async function browserClient() {
  const r = await fetch(`${CDP_BASE}/json/version`)
  if (!r.ok) throw new Error(`/json/version ${r.status}`)
  const v = await r.json()
  if (!v.webSocketDebuggerUrl) throw new Error('no webSocketDebuggerUrl')
  const c = cdpClient(v.webSocketDebuggerUrl)
  await c.ready
  return c
}

async function pageClient(wsUrl) {
  const c = cdpClient(wsUrl)
  await c.ready
  return c
}

async function listTargets() {
  const r = await fetch(`${CDP_BASE}/json/list`)
  if (!r.ok) return []
  return r.json()
}

async function chromiumAlive() {
  try { return (await fetch(`${CDP_BASE}/json/version`)).ok } catch { return false }
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')) } catch { return {} }
}

function originsFromCookies(cookies) {
  const out = new Set()
  for (const c of cookies) {
    const host = (c.domain || '').replace(/^\./, '')
    if (!host) continue
    out.add(`https://${host}`)
  }
  return out
}

// --- WIPE --- //
async function wipe() {
  const browser = await browserClient()
  try {
    const { cookies } = await browser.send('Storage.getCookies')
    let wipedOrigins = 0
    for (const origin of originsFromCookies(cookies)) {
      try {
        await browser.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
        wipedOrigins++
      } catch {}
    }
    await browser.send('Storage.clearCookies')
    const targets = await listTargets()
    const pages = targets.filter(t => t.type === 'page')
    let keptId = null
    for (const p of pages) {
      if (!keptId) {
        try {
          const c = await pageClient(p.webSocketDebuggerUrl)
          await c.send('Page.navigate', { url: HOMEPAGE })
          c.close()
          keptId = p.id
          continue
        } catch {}
      }
      try { await browser.send('Target.closeTarget', { targetId: p.id }) } catch {}
    }
    if (!keptId) {
      try { await browser.send('Target.createTarget', { url: HOMEPAGE }) } catch {}
    }
    lastWipe = new Date().toISOString()
    return { wiped: true, cookies_seen: cookies.length, origins_wiped: wipedOrigins, pages_after: 1, at: lastWipe }
  } finally { browser.close() }
}

// --- DUMP --- //
// Opens a temporary tab per origin (needed for valid execution context),
// reads localStorage via Runtime.evaluate, then closes the tab. The tab
// load HITS the network — acceptable cost for the save_as path.
async function dumpProfile({ domain_filter } = {}) {
  const browser = await browserClient()
  try {
    const { cookies: allCookies } = await browser.send('Storage.getCookies')
    const cookies = domain_filter
      ? allCookies.filter(c => (c.domain || '').includes(domain_filter))
      : allCookies
    const origins = []
    for (const origin of originsFromCookies(cookies)) {
      try {
        const { targetId } = await browser.send('Target.createTarget', { url: origin })
        try {
          // attach a page session via flat session, navigate already happened
          const targets = await listTargets()
          const meta = targets.find(t => t.id === targetId)
          if (!meta?.webSocketDebuggerUrl) throw new Error('no ws for target')
          const page = await pageClient(meta.webSocketDebuggerUrl)
          try {
            // Wait for the document to be ready enough that localStorage exists.
            await page.send('Page.enable')
            await new Promise(r => setTimeout(r, 800))
            const ls = await page.send('Runtime.evaluate', {
              expression: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))',
              returnByValue: true,
            })
            let parsed = {}
            try { parsed = JSON.parse(ls.result?.value || '{}') } catch {}
            origins.push({ origin, localStorage: parsed })
          } finally { page.close() }
        } finally {
          try { await browser.send('Target.closeTarget', { targetId }) } catch {}
        }
      } catch {
        origins.push({ origin, localStorage: {}, error: 'dump_failed' })
      }
    }
    return {
      schema: 'browser-pool/profile@v1',
      saved_at: new Date().toISOString(),
      source: { sidecar: true, domain_filter: domain_filter || null },
      cookies,
      origins,
    }
  } finally { browser.close() }
}

// --- INJECT --- //
async function injectProfile(profile) {
  if (!profile || !Array.isArray(profile.cookies)) {
    throw new Error('profile.cookies missing')
  }
  const browser = await browserClient()
  try {
    // 1. Cookies — bulk set browser-wide. Storage.setCookies takes the same
    // shape Storage.getCookies returns; strip nulls Chrome rejects.
    const cleaned = profile.cookies.map(c => {
      const out = {
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'Lax',
      }
      if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires
      return out
    })
    await browser.send('Storage.setCookies', { cookies: cleaned })

    // 2. localStorage — per origin, open tab, setItem each key, close tab.
    let originsInjected = 0
    for (const o of profile.origins || []) {
      const keys = Object.entries(o.localStorage || {})
      if (!keys.length) continue
      try {
        const { targetId } = await browser.send('Target.createTarget', { url: o.origin })
        try {
          const targets = await listTargets()
          const meta = targets.find(t => t.id === targetId)
          const page = await pageClient(meta.webSocketDebuggerUrl)
          try {
            await new Promise(r => setTimeout(r, 800))
            const expr = `(${JSON.stringify(keys)}).forEach(([k,v]) => localStorage.setItem(k, v)); 'ok'`
            await page.send('Runtime.evaluate', { expression: expr })
            originsInjected++
          } finally { page.close() }
        } finally {
          try { await browser.send('Target.closeTarget', { targetId }) } catch {}
        }
      } catch {}
    }
    return { injected: true, cookies: cleaned.length, origins: originsInjected }
  } finally { browser.close() }
}

// --- STATUS --- //
async function status() {
  const alive = await chromiumAlive()
  let cookieCount = -1, targetCount = -1
  if (alive) {
    try {
      const browser = await browserClient()
      try {
        const { cookies } = await browser.send('Storage.getCookies')
        cookieCount = cookies.length
      } finally { browser.close() }
      const targets = await listTargets()
      targetCount = targets.filter(t => t.type === 'page').length
    } catch {}
  }
  return { chromium_alive: alive, cookie_count: cookieCount, target_count: targetCount, last_wipe_at: lastWipe }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.method === 'POST' && url.pathname === '/wipe')             res.end(JSON.stringify(await wipe()))
    else if (req.method === 'POST' && url.pathname === '/dump-profile') res.end(JSON.stringify(await dumpProfile(await readBody(req))))
    else if (req.method === 'POST' && url.pathname === '/inject-profile') res.end(JSON.stringify(await injectProfile(await readBody(req))))
    else if (req.method === 'GET' && url.pathname === '/status')       res.end(JSON.stringify(await status()))
    else if (req.method === 'GET' && url.pathname === '/healthz')      res.end(JSON.stringify({ ok: true }))
    else { res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' })) }
  } catch (e) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: String(e?.message ?? e) }))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[control-sidecar] listening on :${PORT}, cdp=${CDP_BASE}`)
})
