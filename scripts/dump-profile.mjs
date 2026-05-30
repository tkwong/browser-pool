#!/usr/bin/env node
// Dump cookies + storage from a logged-in chrome-vnc pod to a portable JSON
// profile. Connects via CDP NodePort over Tailscale (no allocator needed).
//
// Usage:
//   node scripts/dump-profile.mjs <domain-filter> <output-path>
//
// Example:
//   node scripts/dump-profile.mjs facebook.com ~/.config/browser-pool/profiles/facebook.json
//
// CDP endpoint is hardcoded to the Tailscale-reachable NodePort. Adjust if
// you move the pool. HttpOnly cookies are captured via Network.getAllCookies
// (CDP), not via document.cookie (which would skip them).

import { chromium } from 'playwright-core'
import { writeFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'

const CDP_URL = process.env.CDP_URL || 'http://100.108.4.108:30922'
const domainFilter = process.argv[2]
const outPath = process.argv[3] && resolve(process.argv[3].replace(/^~/, process.env.HOME))

if (!domainFilter || !outPath) {
  console.error('usage: dump-profile.mjs <domain-substring> <output-path>')
  process.exit(2)
}

const browser = await chromium.connectOverCDP(CDP_URL)
const ctx = browser.contexts()[0]
if (!ctx) {
  console.error('No browser context found at', CDP_URL)
  process.exit(1)
}

// 1. All cookies for the context (includes HttpOnly + Secure, all domains).
const allCookies = await ctx.cookies()
const cookies = allCookies.filter(c => c.domain.includes(domainFilter))

// 2. Per-origin localStorage + sessionStorage. Pick the matching page (or
// open a fresh tab if none) so document.* runs in the right origin.
const pages = ctx.pages()
let page = pages.find(p => {
  try { return new URL(p.url()).hostname.includes(domainFilter) } catch { return false }
})
if (!page) {
  console.error(`No open tab matching "${domainFilter}". Open one then re-run.`)
  process.exit(1)
}

const storage = await page.evaluate(() => ({
  localStorage:   Object.fromEntries(Object.entries(localStorage)),
  sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
}))

const profile = {
  schema:    'browser-pool/profile@v1',
  saved_at:  new Date().toISOString(),
  source: { cdp_url: CDP_URL, domain_filter: domainFilter, origin_url: page.url() },
  cookies,
  origins: [{ origin: new URL(page.url()).origin, ...storage }],
}

writeFileSync(outPath, JSON.stringify(profile, null, 2))
chmodSync(outPath, 0o600)

console.log(JSON.stringify({
  ok: true,
  out: outPath,
  cookie_count: cookies.length,
  http_only:    cookies.filter(c => c.httpOnly).length,
  secure:       cookies.filter(c => c.secure).length,
  local_storage_keys:   Object.keys(storage.localStorage).length,
  session_storage_keys: Object.keys(storage.sessionStorage).length,
  origin: profile.origins[0].origin,
}, null, 2))

await browser.close()
