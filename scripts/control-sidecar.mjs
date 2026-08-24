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
//   POST /snapshot        body: {include_service_worker?: false}
//                         → { schema, saved_at, covers, paths, bytes, sha256,
//                             tar_b64, timing }
//                           Full on-disk profile tarball — the ONLY format that
//                           carries IndexedDB, and therefore the only one that
//                           can restore a WhatsApp Web login. Stops chromium for
//                           ~2s (s6 svc-watchdog relaunches it).
//   POST /restore         body: {tar_b64}
//                         → { restored, bytes, entries, replaced, sha256, timing }
//   GET  /tabs            → { tabs: [{ url, title, history: [urls] }], at }
//                           per open page target, its back/forward nav stack
//                           (Page.getNavigationHistory). Read-only; the
//                           allocator snapshots this at release for the audit log.

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const PORT     = parseInt(process.env.CONTROL_PORT || '9224', 10)
const CDP_BASE = process.env.CDP_BASE || 'http://localhost:9223'
const HOMEPAGE = process.env.HOMEPAGE_URL || 'about:blank'
// The Chromium profile on the per-pod `config` PVC. Read by /wipe (origin
// discovery) and by /snapshot + /restore (the tarball).
const PROFILE_ROOT = process.env.PROFILE_ROOT || '/config/.config/chromium'

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
// --- disk-derived origins (the wipe safety net) --- //
// Open tabs + cookie domains both miss the same case: an origin that stored
// something and then had its tab closed AND holds no cookie. A site that keeps
// its whole session in IndexedDB (web.whatsapp.com is exactly this) is
// invisible to both, so /wipe would skip it and leak the session into the next
// lease. The profile directory on disk cannot miss it — the data IS the
// directory.
//
// Two sources, because Chromium lays them out differently:
//   IndexedDB    one dir per origin: `https_web.whatsapp.com_0.indexeddb.leveldb`
//   Local Storage  ONE shared LevelDB; origins appear inside it as `META:<origin>`
// The second needs a byte scan, but these files are small (hundreds of KB) and
// a plain regex over them is far cheaper than opening a LevelDB.
const LOCAL_STORAGE_SCAN_BUDGET = 32 * 1024 * 1024   // stop reading past this

function originFromIdbDirName(name) {
  // `<scheme>_<host>_<port>.indexeddb.leveldb`; host may itself contain `_`,
  // so peel scheme off the front and port off the back rather than splitting.
  const base = name.replace(/\.indexeddb\.leveldb$/, '')
  const us = base.indexOf('_')
  const ue = base.lastIndexOf('_')
  if (us < 0 || ue <= us) return null
  const scheme = base.slice(0, us)
  const host = base.slice(us + 1, ue)
  const port = base.slice(ue + 1)
  if (scheme !== 'https' && scheme !== 'http') return null
  if (!host) return null
  // port 0 is Chromium's "default port" marker, not a real port.
  return port && port !== '0' ? `${scheme}://${host}:${port}` : `${scheme}://${host}`
}

async function originsFromDisk() {
  const out = new Set()

  try {
    const dir = `${PROFILE_ROOT}/Default/IndexedDB`
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.indexeddb.leveldb')) continue
      const o = originFromIdbDirName(e.name)
      if (o) out.add(o)
    }
  } catch {}   // no mount / no IndexedDB yet — the other sources still apply

  try {
    const dir = `${PROFILE_ROOT}/Default/Local Storage/leveldb`
    let budget = LOCAL_STORAGE_SCAN_BUDGET
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile()) continue
      if (!/\.(ldb|log)$/.test(e.name)) continue
      if (budget <= 0) break
      let buf
      try { buf = await fs.readFile(`${dir}/${e.name}`) } catch { continue }
      budget -= buf.length
      // latin1 keeps every byte addressable as one char, so offsets in the
      // regex match the file and no multi-byte decode can split a key.
      for (const m of buf.toString('latin1').matchAll(/META:(https?:\/\/[^\x00-\x20"']{1,255})/g)) {
        try { out.add(new URL(m[1]).origin) } catch {}
      }
    }
  } catch {}

  return out
}

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
  // Disk last: catches the cookie-less, tab-less origins the two above cannot
  // see. Clearing an origin that stored nothing is a no-op, so over-collecting
  // here is free — under-collecting is what leaks a session.
  for (const o of await originsFromDisk()) out.add(o)
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

// --------------------------------------------------------------------------- //
// Full-profile snapshot / restore                                             //
// --------------------------------------------------------------------------- //
//
// Why this exists: the JSON profile above (`/dump-profile`) covers cookies +
// localStorage and nothing else, because those are the only two stores CDP can
// both read AND write. IndexedDB is readable via the `IndexedDB.*` domain but
// there is no write side, and the values that matter most are not even
// representable in JSON — WhatsApp Web keeps its session as **non-extractable
// CryptoKey objects**, which by definition no JS or CDP API can export. So a
// JSON round-trip can never restore that login, no matter how many stores we
// add to it.
//
// What does work is copying the on-disk profile. IndexedDB is a LevelDB
// directory, Local Storage is a LevelDB directory, and cookies are a SQLite
// file — all of them portable between pods here because chromium runs with
// `--password-store=basic` (see /usr/bin/wrapped-chromium), so OSCrypt derives
// its key from the hardcoded "peanuts" password rather than a per-host keyring.
// A tarball taken on chrome-vnc-3 therefore decrypts on chrome-vnc-5.
//
// Chromium must not be running while its profile is read or written:
//  - Restore is obvious — Chromium holds the LevelDB LOCK files and would both
//    ignore and clobber anything written underneath it.
//  - Snapshot is subtler. LevelDB writes its WAL with sync=false, which only
//    means "not durable against a machine crash"; the bytes are in the page
//    cache and any reader on this host sees them. So a live copy is *usually*
//    fine — but "usually" is not a property you want in a session key, and a
//    write landing mid-tar yields a torn manifest. We stop first.
//
// Stopping is safe because the image ships an s6 `svc-watchdog` that polls
// once a second and relaunches the openbox autostart (→ wrapped-chromium) as
// soon as it disappears. That watchdog is inert unless `RESTART_APP=true`,
// which k8s/40-chrome-vnc-poc.yaml now sets. Without it a clean `Browser.close`
// left the pod browser-less until the liveness probe recycled the container
// ~3 minutes later — which is also what used to happen after any Chromium
// crash (chrome-vnc-5 was carrying a 387 MB `core` from one).

// Tarred by /snapshot, relative to PROFILE_ROOT. Missing entries are skipped,
// so this can list paths that only exist on some Chromium versions (cookies
// moved Default/Cookies → Default/Network/Cookies).
//
// Deliberately excluded: everything that is a cache and nothing else — Cache,
// Code Cache, GPUCache, Dawn*Cache, GrShaderCache, component_crx_cache,
// Crash Reports. They are the bulk of the 126 MB profile and regenerate on
// demand; the set below is ~8 MB.
const SNAPSHOT_PATHS = [
  'Local State',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Network',            // newer Chromium: Cookies, TransportSecurity here
  'Default/Local Storage',
  'Default/Session Storage',
  'Default/IndexedDB',          // ← the whole point
  'Default/databases',          // legacy WebSQL
  'Default/WebStorage',
  'Default/Web Data',
  'Default/Login Data',
  'Default/Trust Tokens',
]

// 'Service Worker' is opt-in: it is 15 MB of it (ScriptCache/CacheStorage) and
// restoring a stale registration alongside fresh IndexedDB is more likely to
// confuse a site than to help it. The registration re-installs on first load.
const SERVICE_WORKER_PATH = 'Default/Service Worker'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function run(cmd, args, stdin = null) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = [], err = []
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => err.push(d))
    p.on('error', reject)
    p.on('close', code => {
      const stderr = Buffer.concat(err).toString('utf-8')
      if (code !== 0) return reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 400)}`))
      resolve({ stdout: Buffer.concat(out), stderr })
    })
    p.stdin.on('error', () => {})
    if (stdin) p.stdin.end(stdin)
    else p.stdin.end()
  })
}

// Ask Chromium to exit cleanly so LevelDB flushes and the cookie DB closes.
// Browser.close never replies — the socket dies with the process — so fire it
// and poll the relay instead of awaiting the CDP response.
async function stopChromium(timeoutMs = 25000) {
  const t0 = Date.now()
  try {
    const b = await browserClient()
    b.send('Browser.close').catch(() => {})
    setTimeout(() => b.close(), 500)
  } catch (e) {
    if (!(await chromiumAlive())) return { down: true, ms: 0, note: 'already down' }
    return { down: false, ms: Date.now() - t0, error: String(e?.message ?? e) }
  }
  while (Date.now() - t0 < timeoutMs) {
    if (!(await chromiumAlive())) return { down: true, ms: Date.now() - t0 }
    await sleep(250)
  }
  return { down: false, ms: Date.now() - t0, error: 'still alive after Browser.close' }
}

async function waitChromiumUp(timeoutMs = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await chromiumAlive()) return { up: true, ms: Date.now() - t0 }
    await sleep(500)
  }
  return { up: false, ms: Date.now() - t0, error: 'watchdog did not relaunch chromium' }
}

async function existingSnapshotPaths(includeServiceWorker) {
  const wanted = includeServiceWorker ? [...SNAPSHOT_PATHS, SERVICE_WORKER_PATH] : SNAPSHOT_PATHS
  const present = []
  for (const rel of wanted) {
    try { await fs.stat(`${PROFILE_ROOT}/${rel}`); present.push(rel) } catch {}
  }
  return present
}

// A tar entry is only accepted if it stays inside the profile. Anything
// absolute, anything with a '..' component, and anything not under
// Default/ or the single top-level 'Local State' file is rejected outright —
// the tarball arrives from the allocator's profile store, which is writable
// via PUT /profiles/{name}.
function assertSafeEntries(entries) {
  for (const raw of entries) {
    const e = raw.replace(/\/+$/, '')
    if (!e) continue
    if (e.startsWith('/') || e.includes('\0')) throw new Error(`unsafe tar entry: ${raw}`)
    const parts = e.split('/')
    if (parts.includes('..') || parts.includes('.')) throw new Error(`unsafe tar entry: ${raw}`)
    if (!(e === 'Local State' || parts[0] === 'Default')) {
      throw new Error(`tar entry outside profile: ${raw}`)
    }
  }
}

async function snapshotProfile({ include_service_worker = false } = {}) {
  const t0 = Date.now()
  const stopped = await stopChromium()
  if (!stopped.down) {
    throw new Error(`refusing to snapshot a live profile: ${stopped.error || 'chromium still running'}`)
  }
  let tar, paths, restarted
  try {
    paths = await existingSnapshotPaths(include_service_worker)
    if (!paths.length) throw new Error(`no profile paths found under ${PROFILE_ROOT}`)
    tar = (await run('tar', ['-czf', '-', '-C', PROFILE_ROOT, ...paths])).stdout
  } finally {
    // Always bring the browser back, even if tar blew up.
    restarted = await waitChromiumUp()
  }
  return {
    schema: 'browser-pool/profile-tar@v1',
    saved_at: new Date().toISOString(),
    covers: { cookies: true, localStorage: true, indexedDB: true, serviceWorkers: !!include_service_worker },
    paths,
    bytes: tar.length,
    sha256: crypto.createHash('sha256').update(tar).digest('hex'),
    tar_b64: tar.toString('base64'),
    timing: { stop: stopped, restart: restarted, total_ms: Date.now() - t0 },
  }
}

async function restoreProfile({ tar_b64 } = {}) {
  if (typeof tar_b64 !== 'string' || !tar_b64) throw new Error('tar_b64 missing')
  const tar = Buffer.from(tar_b64, 'base64')
  if (tar.length < 3 || tar[0] !== 0x1f || tar[1] !== 0x8b) throw new Error('tar_b64 is not a gzip stream')

  // Validate BEFORE stopping the browser, so a bad payload costs nothing.
  const listing = (await run('tar', ['-tzf', '-'], tar)).stdout.toString('utf-8')
  const entries = listing.split('\n').map(s => s.trim()).filter(Boolean)
  if (!entries.length) throw new Error('tarball is empty')
  assertSafeEntries(entries)

  // Directories being replaced wholesale. LevelDB stores must not be merged:
  // leaving stale .ldb/MANIFEST files next to restored ones gives a corrupt DB.
  const replaced = [...new Set(
    entries.filter(e => e.startsWith('Default/'))
           .map(e => e.replace(/\/+$/, '').split('/').slice(0, 2).join('/'))
  )]

  const t0 = Date.now()
  const stopped = await stopChromium()
  if (!stopped.down) {
    throw new Error(`refusing to overwrite a live profile: ${stopped.error || 'chromium still running'}`)
  }
  let restarted
  try {
    for (const rel of replaced) {
      await fs.rm(`${PROFILE_ROOT}/${rel}`, { recursive: true, force: true }).catch(() => {})
    }
    await fs.mkdir(PROFILE_ROOT, { recursive: true })
    await run('tar', ['-xzf', '-', '-C', PROFILE_ROOT], tar)
    // The control container is root; chromium runs as PUID/PGID (1000). Match
    // whatever already owns the profile root rather than hardcoding the uid.
    const owner = await fs.stat(PROFILE_ROOT)
    await run('chown', ['-R', `${owner.uid}:${owner.gid}`, PROFILE_ROOT])
  } finally {
    restarted = await waitChromiumUp()
  }
  return {
    restored: true,
    bytes: tar.length,
    entries: entries.length,
    replaced,
    sha256: crypto.createHash('sha256').update(tar).digest('hex'),
    timing: { stop: stopped, restart: restarted, total_ms: Date.now() - t0 },
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  res.setHeader('Content-Type', 'application/json')
  try {
    if (req.method === 'POST' && url.pathname === '/wipe')             res.end(JSON.stringify(await wipe()))
    else if (req.method === 'POST' && url.pathname === '/dump-profile') res.end(JSON.stringify(await dumpProfile(await readBody(req))))
    else if (req.method === 'POST' && url.pathname === '/inject-profile') res.end(JSON.stringify(await injectProfile(await readBody(req))))
    else if (req.method === 'POST' && url.pathname === '/snapshot')   res.end(JSON.stringify(await snapshotProfile(await readBody(req))))
    else if (req.method === 'POST' && url.pathname === '/restore')    res.end(JSON.stringify(await restoreProfile(await readBody(req))))
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
