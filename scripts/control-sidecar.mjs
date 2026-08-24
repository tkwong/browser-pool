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
//                           + clear the X11 CLIPBOARD/PRIMARY/SECONDARY
//                           selections (pod-level state a cookie wipe misses)
//   POST /dump-profile    body: {domain_filter?: "facebook.com"}
//                         → { schema, saved_at, cookies, origins[{origin, localStorage}] }
//   POST /inject-profile  body: profile JSON (same shape dump produces)
//                         → { injected, cookies, origins }
//   GET  /tabs            → { tabs: [{ url, title, history: [urls] }], at }
//                           per open page target, its back/forward nav stack
//                           (Page.getNavigationHistory). Read-only; the
//                           allocator snapshots this at release for the audit log.

import http from 'node:http'
import net from 'node:net'

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

// Cookie domains alone are NOT enough to find where a site keeps its storage.
// localStorage/IndexedDB are keyed by ORIGIN (scheme+host+port), while a cookie
// is keyed by a DOMAIN that is deliberately broader: a `.whatsapp.com` cookie
// tells us nothing about `https://web.whatsapp.com`, which is the origin that
// actually holds the WhatsApp Web session. Deriving `https://whatsapp.com` from
// it — as this used to — reads the wrong (empty) bucket and silently reports
// success. The open tabs are the authoritative source: they are the origins the
// leaseholder was really signed in to.
async function discoverOrigins(cookies = []) {
  const out = new Set()
  for (const t of await listTargets()) {
    if (t.type !== 'page') continue
    try {
      const u = new URL(t.url)
      if (u.protocol === 'https:' || u.protocol === 'http:') out.add(u.origin)
    } catch {}
  }
  // Cookie domains stay as a fallback for tabs closed before release.
  for (const o of originsFromCookies(cookies)) out.add(o)
  return out
}

// origin -> an already-open page target for it. Reusing the live tab avoids a
// network round-trip AND avoids reading a freshly-opened tab that may not have
// hydrated its storage yet.
async function openTabsByOrigin() {
  const map = new Map()
  for (const t of await listTargets()) {
    if (t.type !== 'page' || !t.webSocketDebuggerUrl) continue
    try {
      const o = new URL(t.url).origin
      if (!map.has(o)) map.set(o, t)
    } catch {}
  }
  return map
}

// --- X11 selection clear (clipboard hygiene) --- //
// The X server holds three selections (PRIMARY / SECONDARY / CLIPBOARD) and
// they are POD-level state, not browser state: `Storage.clearCookies` does not
// touch them, so whatever the previous leaseholder copied (verified in the
// wild: a generated password, plus selected page text) stayed readable by the
// next leaseholder through the noVNC clipboard panel.
//
// We speak raw X11 over the Xvfb unix socket instead of shelling out to xsel:
// node:22-alpine has no X client, and Xvfb here runs `-ac` (access control
// off, no XAUTHORITY), so an unauthenticated connection is all it takes.
// Clearing a selection in X means SetSelectionOwner(owner=None) — there is no
// buffer to blank; with no owner, a paste simply yields nothing.
const X11_SOCKET = process.env.X11_SOCKET || '/tmp/.X11-unix/X1'

function clearXSelections(sockPath = X11_SOCKET, timeoutMs = 3000) {
  return new Promise(resolve => {
    let settled = false
    let sock
    const finish = r => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock?.destroy() } catch {}
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs)
    try { sock = net.connect(sockPath) } catch (e) { return finish({ ok: false, error: String(e?.message ?? e) }) }
    sock.on('error', e => finish({ ok: false, error: String(e?.message ?? e) }))

    let buf = Buffer.alloc(0)
    let phase = 'setup'
    const cleared = []

    // SetSelectionOwner(owner=None, selection=atom, time=CurrentTime). No reply.
    const setOwnerNone = atom => {
      const r = Buffer.alloc(16)
      r.writeUInt8(22, 0)          // opcode
      r.writeUInt8(0, 1)           // unused
      r.writeUInt16LE(4, 2)        // request length (4 words)
      r.writeUInt32LE(0, 4)        // owner = None
      r.writeUInt32LE(atom, 8)     // selection
      r.writeUInt32LE(0, 12)       // time = CurrentTime
      sock.write(r)
    }

    sock.on('connect', () => {
      const s = Buffer.alloc(12)
      s.write('l', 0, 'ascii')     // little-endian
      s.writeUInt16LE(11, 2)       // protocol-major
      s.writeUInt16LE(0, 4)        // protocol-minor
      s.writeUInt16LE(0, 6)        // auth-proto-name length
      s.writeUInt16LE(0, 8)        // auth-proto-data length
      sock.write(s)
    })

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (phase === 'setup') {
          if (buf.length < 8) return
          if (buf.readUInt8(0) !== 1) return finish({ ok: false, error: `setup rejected (code ${buf.readUInt8(0)})` })
          const total = 8 + 4 * buf.readUInt16LE(6)
          if (buf.length < total) return
          buf = buf.subarray(total)
          phase = 'atom'
          // InternAtom("CLIPBOARD") — PRIMARY(1) and SECONDARY(2) are
          // predefined atoms, CLIPBOARD is not.
          const name = Buffer.from('CLIPBOARD', 'ascii')
          const pad = (4 - (name.length % 4)) % 4
          const req = Buffer.alloc(8 + name.length + pad)
          req.writeUInt8(16, 0)                                   // opcode
          req.writeUInt8(0, 1)                                    // only-if-exists = false
          req.writeUInt16LE(2 + (name.length + pad) / 4, 2)       // request length
          req.writeUInt16LE(name.length, 4)
          name.copy(req, 8)
          sock.write(req)
          continue
        }
        if (buf.length < 32) return
        const kind = buf.readUInt8(0)
        if (kind === 0) return finish({ ok: false, error: `X error code ${buf.readUInt8(1)} in ${phase}` })
        if (kind !== 1) { buf = buf.subarray(32); continue }       // event — ignore
        const extra = 4 * buf.readUInt32LE(4)
        if (buf.length < 32 + extra) return
        const reply = buf.subarray(0, 32 + extra)
        buf = buf.subarray(32 + extra)
        if (phase === 'atom') {
          const clipboard = reply.readUInt32LE(8)
          for (const [nm, atom] of [['PRIMARY', 1], ['SECONDARY', 2], ['CLIPBOARD', clipboard]]) {
            if (!atom) continue
            setOwnerNone(atom)
            cleared.push(nm)
          }
          phase = 'sync'
          // GetInputFocus round-trip: its reply proves the server already
          // processed the SetSelectionOwner requests queued before it.
          const gif = Buffer.alloc(4)
          gif.writeUInt8(43, 0)
          gif.writeUInt16LE(1, 2)
          sock.write(gif)
          continue
        }
        return finish({ ok: true, cleared })
      }
    })
  })
}

// Belt-and-braces: make Chrome itself overwrite CLIPBOARD. Covers the case
// where the X socket is not mounted into this sidecar (older pod spec), since
// Chrome takes selection ownership when it writes.
async function clearClipboardViaCdp() {
  const browser = await browserClient()
  try {
    await browser.send('Browser.grantPermissions', {
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    }).catch(() => {})
    const page = (await listTargets()).find(t => t.type === 'page')
    if (!page?.webSocketDebuggerUrl) return { ok: false, error: 'no page target' }
    const p = await pageClient(page.webSocketDebuggerUrl)
    try {
      // writeText() throws "Document is not focused" on a background tab.
      await p.send('Page.bringToFront').catch(() => {})
      await p.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      const r = await p.send('Runtime.evaluate', {
        expression: `(async()=>{try{await navigator.clipboard.writeText('');return 'ok'}catch(e){return 'err:'+e.message}})()`,
        awaitPromise: true, returnByValue: true, userGesture: true,
      })
      return { ok: r.result?.value === 'ok', detail: r.result?.value }
    } finally { p.close() }
  } finally { browser.close() }
}

async function clearClipboard() {
  const x11 = await clearXSelections()
  // Only pay for the CDP path when the raw X path could not run.
  const cdp = x11.ok ? null : await clearClipboardViaCdp().catch(e => ({ ok: false, error: String(e?.message ?? e) }))
  return { x11, cdp }
}

// --- WIPE --- //
async function wipe() {
  const browser = await browserClient()
  let wipedSummary = { cookies_seen: 0, origins_seen: 0, origins_wiped: 0, origins_failed: [] }
  try {
    const { cookies } = await browser.send('Storage.getCookies')
    // discoverOrigins(), not originsFromCookies(): otherwise a site whose
    // storage lives on a subdomain (web.whatsapp.com) keeps its localStorage
    // and IndexedDB across leases even though its cookies were cleared.
    const origins = [...await discoverOrigins(cookies)]

    // Storage.clearDataForOrigin MUST be sent on a PAGE session. On the
    // browser-level session Chrome rejects every call with -32603 "Internal
    // error", and this loop used to swallow that in a bare `catch {}` — so
    // every wipe reported success while localStorage and IndexedDB survived
    // the lease completely untouched. Measured 2026-08-23: a key seeded before
    // /wipe was still readable after it. Only cookies were ever being cleared.
    // Any page target works as the transport — the call is cross-origin
    // (verified clearing web.whatsapp.com from a tab sitting on example.com).
    let storageTarget = (await listTargets()).find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    if (!storageTarget) {
      try {
        await browser.send('Target.createTarget', { url: HOMEPAGE })
        await new Promise(r => setTimeout(r, 500))
        storageTarget = (await listTargets()).find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      } catch {}
    }
    let wipedOrigins = 0
    let failedOrigins = []
    if (!storageTarget) {
      failedOrigins = origins.map(o => `${o}: no page session`)
    } else {
      const sp = await pageClient(storageTarget.webSocketDebuggerUrl)
      try {
        for (const origin of origins) {
          try {
            await sp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
            wipedOrigins++
          } catch (e) {
            // Surfaced in the response, never swallowed: a silent failure here
            // is a cross-tenant data leak, not a cosmetic problem.
            failedOrigins.push(`${origin}: ${e?.message ?? e}`)
          }
        }
      } finally { sp.close() }
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
    wipedSummary = {
      cookies_seen: cookies.length,
      origins_seen: origins.length,
      origins_wiped: wipedOrigins,
      origins_failed: failedOrigins,
    }
  } finally { browser.close() }
  // X selections last: clearClipboardViaCdp() needs chromium reachable, and
  // the CLIPBOARD content is the highest-value leak (a copied password
  // survived a release in the wild before this existed).
  const clipboard = await clearClipboard().catch(e => ({ error: String(e?.message ?? e) }))
  return { wiped: true, ...wipedSummary, pages_after: 1, clipboard, at: lastWipe }
}

// --- DUMP --- //
// Reads localStorage for every origin we can find. Prefers the tab that is
// already open on that origin (no network hit, and its storage is definitely
// hydrated); falls back to a temporary tab for origins we only know from
// cookies. NOTE: IndexedDB is NOT captured — sites that keep their session
// there (WhatsApp Web, most E2EE web clients) will not be restored by a
// profile saved this way. `covers` says so explicitly rather than letting a
// caller assume a full snapshot.
async function dumpProfile({ domain_filter } = {}) {
  const browser = await browserClient()
  try {
    const { cookies: allCookies } = await browser.send('Storage.getCookies')
    const cookies = domain_filter
      ? allCookies.filter(c => (c.domain || '').includes(domain_filter))
      : allCookies
    let originList = [...await discoverOrigins(cookies)]
    if (domain_filter) originList = originList.filter(o => o.includes(domain_filter))
    const openTabs = await openTabsByOrigin()

    const readLocalStorage = async wsUrl => {
      const page = await pageClient(wsUrl)
      try {
        const ls = await page.send('Runtime.evaluate', {
          expression: 'JSON.stringify(Object.fromEntries(Object.entries(localStorage)))',
          returnByValue: true,
        })
        try { return JSON.parse(ls.result?.value || '{}') } catch { return {} }
      } finally { page.close() }
    }

    const origins = []
    for (const origin of originList) {
      const live = openTabs.get(origin)
      if (live) {
        try {
          origins.push({ origin, localStorage: await readLocalStorage(live.webSocketDebuggerUrl), from: 'open_tab' })
          continue
        } catch { /* fall through to a temp tab */ }
      }
      try {
        const { targetId } = await browser.send('Target.createTarget', { url: origin })
        try {
          const meta = (await listTargets()).find(t => t.id === targetId)
          if (!meta?.webSocketDebuggerUrl) throw new Error('no ws for target')
          // Give the document time to exist before touching localStorage.
          await new Promise(r => setTimeout(r, 800))
          origins.push({ origin, localStorage: await readLocalStorage(meta.webSocketDebuggerUrl), from: 'temp_tab' })
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
      covers: { cookies: true, localStorage: true, indexedDB: false, serviceWorkers: false },
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

// --- TABS (browsing history) --- //
// For each open page target, return its navigation stack via
// Page.getNavigationHistory. Captures the journey within still-open tabs
// (A->B->C). Closed tabs are gone — this is a release-time snapshot, not a
// continuous recorder. Read-only: opens no tabs, hits no network.
async function tabs() {
  const targets = (await listTargets()).filter(t => t.type === 'page')
  const out = []
  for (const t of targets) {
    let history = []
    if (t.webSocketDebuggerUrl) {
      try {
        const page = await pageClient(t.webSocketDebuggerUrl)
        try {
          const nav = await page.send('Page.getNavigationHistory')
          history = (nav.entries || [])
            .map(e => e.url)
            .filter(u => u && u !== 'about:blank')
        } finally { page.close() }
      } catch {}
    }
    out.push({ url: t.url, title: t.title || '', history })
  }
  return { tabs: out, at: new Date().toISOString() }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.method === 'POST' && url.pathname === '/wipe')             res.end(JSON.stringify(await wipe()))
    else if (req.method === 'POST' && url.pathname === '/dump-profile') res.end(JSON.stringify(await dumpProfile(await readBody(req))))
    else if (req.method === 'POST' && url.pathname === '/inject-profile') res.end(JSON.stringify(await injectProfile(await readBody(req))))
    else if (req.method === 'GET' && url.pathname === '/tabs')          res.end(JSON.stringify(await tabs()))
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
