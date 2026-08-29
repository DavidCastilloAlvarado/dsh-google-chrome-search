/**
 * dsh-google-chrome-search — core search engine.
 *
 * Drives the *local* Chrome over CDP (puppeteer-core, no bundled browser) to run a
 * Google web search. The normal path is headless. When Google serves a
 * human-verification page (CAPTCHA / "unusual traffic"), the module reopens a
 * *visible* Chrome window pointed at the verification page, waits for the human to
 * solve it, and then extracts the results from that same (now trusted) session.
 *
 * A persistent, dedicated Chrome profile (never the user's real browser) keeps the
 * "verified" cookies between calls, so once the human has verified once, later
 * searches frequently succeed headless.
 *
 * Public API: `googleSearch(query, options) -> SearchOutcome`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import puppeteer from 'puppeteer-core'
import { findBundledBrowser } from './browser.mjs'

// ---------------------------------------------------------------------------
// Configuration (overridable via env or options)
// ---------------------------------------------------------------------------

/**
 * Resolve the Chrome/Chromium executable to drive.
 *
 * Chain: --chrome flag → CHROME_PATH env → bundled Chrome for Testing
 * (installed via `install-browser` into the profile dir) → well-known system
 * install paths → bare-name passthrough (PATH lookup on POSIX).
 */
export function resolveChromePath(env = process.env, opts = {}) {
  if (opts.chromePath) return opts.chromePath
  if (env.CHROME_PATH) return env.CHROME_PATH
  const bundled = findBundledBrowser(opts.profileDir || defaultProfileDir())
  if (bundled) return bundled
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome',
    'chromium',
  ]
  for (const c of candidates) {
    try {
      if (c.includes('/') && !fs.existsSync(c)) continue
      // For bare names, existence is checked by the caller via which(); we keep
      // them as a last-resort passthrough so puppeteer can resolve them.
      return c
    } catch {
      /* ignore */
    }
  }
  return 'google-chrome'
}

/** Default persistent, dedicated profile dir (isolated from the user's real Chrome). */
export function defaultProfileDir() {
  return process.env.GSEARCH_PROFILE || path.join(os.homedir(), '.dsh-chrome-google')
}

/** Strong, low-false-positive human-verification markers seen on Google's /sorry page. */
const STRONG_MARKERS = [
  'unusual traffic',
  'not a robot',
  'are you a robot',
  'verify you are human',
  'before you continue',
  'complete the captcha',
  'enable javascript',
]
const CAPTCHA_MARKERS = ['recaptcha', 'captcha']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Build the Google search URL for a query. */
export function searchUrl(query, { gl = 'us', hl = 'en', num = 15 } = {}) {
  const p = new URLSearchParams()
  p.set('q', query)
  p.set('hl', hl)
  p.set('gl', gl)
  p.set('num', String(num))
  p.set('ie', 'UTF-8')
  return `https://www.google.com/search?${p.toString()}`
}

/**
 * True if `href` is one of Google's redirect wrappers (google.com/goto or
 * google.com/url) whose real destination must be resolved separately.
 */
function isRedirectWrapper(href) {
  try {
    const u = new URL(href, 'https://www.google.com')
    return /(google\.[a-z.]+)$/i.test(u.hostname) && (u.pathname === '/goto' || u.pathname === '/url')
  } catch {
    return false
  }
}

/** If the wrapper carries its destination in plaintext (/url?q=…), return it. */
function unwrapPlaintext(href) {
  try {
    const u = new URL(href, 'https://www.google.com')
    if (u.pathname === '/url' && u.searchParams.has('q')) return u.searchParams.get('q')
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Launch a throwaway headless Chrome (temporary profile) used ONLY to resolve
 * Google's /goto redirect wrappers. The destination document request is
 * intercepted and aborted so nothing actually loads — each probe is a single
 * redirect hop (~200 ms). /goto payloads are obfuscated, so following the
 * redirect is the only reliable way to recover the real URL; no session
 * cookies are required (verified: a fresh profile resolves them fine).
 */
async function makeRedirectProber(executablePath, log) {
  const profile = path.join(os.tmpdir(), `dsh-gsearch-probe-${process.pid}-${Date.now()}`)
  fs.mkdirSync(profile, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: profile,
    dumpio: false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--no-sandbox'],
    timeout: 30000,
  })
  const page = (await browser.pages())[0] || (await browser.newPage())
  await page.setRequestInterception(true)
  let target = null
  let firstNav = true
  page.on('request', (req) => {
    if (!req.isNavigationRequest()) {
      req.abort().catch(() => {})
      return
    }
    if (firstNav) {
      // Let the /goto request itself through so we receive its 302.
      firstNav = false
      req.continue().catch(() => {})
      return
    }
    // The redirect target: record it, then abort so nothing loads.
    target = req.url()
    req.abort().catch(() => {})
  })
  const resolve = async (href) => {
    target = null
    firstNav = true
    const abs = href.startsWith('http') ? href : 'https://www.google.com' + href
    try {
      await page.goto(abs, { waitUntil: 'domcontentloaded', timeout: 10000 })
    } catch {
      /* the destination request is aborted on purpose */
    }
    return target || null
  }
  const close = async () => {
    try {
      await browser.close()
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  log('redirect prober ready (throwaway headless chrome)')
  return { resolve, close }
}

/**
 * Resolve Google redirect wrappers in `results` to real destination URLs.
 * /url?q= wrappers are unwrapped locally; /goto wrappers are resolved by
 * following the redirect on a throwaway headless browser. Failures leave the
 * wrapper URL as-is (it still works when clicked in a browser).
 */
async function resolveLinks(results, chromePath, log) {
  const pending = []
  for (const r of results) {
    if (!isRedirectWrapper(r.link)) continue
    const plain = unwrapPlaintext(r.link)
    if (plain) {
      r.link = plain
      continue
    }
    pending.push(r)
  }
  if (pending.length === 0) return
  let prober = null
  try {
    prober = await makeRedirectProber(chromePath, log)
    for (const r of pending) {
      const real = await prober.resolve(r.link)
      if (real && /^https?:/i.test(real) && !isRedirectWrapper(real)) r.link = real
    }
  } catch (e) {
    log(`could not resolve redirect links: ${e && e.message ? e.message : String(e)}`)
  } finally {
    if (prober) await prober.close()
  }
}

/**
 * Extract organic search results from the rendered page.
 *
 * Returns RAW candidates: links may still be Google redirect wrappers
 * (/goto, /url) — call resolveLinks() to turn them into real URLs.
 *
 * @returns {{url:string,title:string,results:{title:string,link:string,snippet:string}[]}}
 */
async function readResults(page) {
  return page.evaluate(() => {
    const ABS_BASE = 'https://www.google.com'
    const isGoogleHost = (l) => /^(https?:)?\/\/(www\.)?(google\.|accounts\.google\.|maps\.google\.|support\.google\.|play\.google\.)/.test(l)
    const isWrapper = (l) => {
      try {
        const u = new URL(l, ABS_BASE)
        return /(google\.[a-z.]+)$/i.test(u.hostname) && (u.pathname === '/goto' || u.pathname === '/url')
      } catch {
        return false
      }
    }
    const out = []
    const seen = new Set()
    const push = (title, rawHref, snippet) => {
      const t = (title || '').trim().replace(/\s+/g, ' ')
      const href = rawHref ? rawHref.trim() : ''
      if (!t || !href || href.startsWith('javascript:')) return
      const abs = href.startsWith('http') ? href : ABS_BASE + (href.startsWith('/') ? href : '/' + href)
      if (!isWrapper(abs) && isGoogleHost(abs)) return
      const key = abs + '|' + t
      if (seen.has(key)) return
      seen.add(key)
      out.push({ title: t, link: abs, snippet: (snippet || '').trim().replace(/\s+/g, ' ') })
    }

    // Preferred: Google's per-result containers (pair each h3 with its own anchor).
    for (const b of document.querySelectorAll('div.g, div[data-hveid]')) {
      const h3 = b.querySelector('h3')
      if (!h3) continue
      const a = h3.closest('a[href]')
      if (!a) continue
      const snip =
        b.querySelector('div.VwiC3b, div.islvi, span.aCOpRe, div[data-sncf], div[style*="line-clamp"], p')
      push(h3.textContent, a.getAttribute('href'), snip ? snip.textContent : '')
    }

    // Fallback: any h3 with a link.
    if (out.length === 0) {
      for (const h3 of document.querySelectorAll('h3')) {
        const a = h3.closest('a[href]') || h3.querySelector('a[href]')
        if (!a) continue
        push(h3.textContent, a.getAttribute('href'), '')
      }
    }
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body && document.body.innerText) || '',
      results: out,
    }
  })
}

/** Classify a rendered Google page as ok / captcha / no-results. */
function classify(pageInfo) {
  const { url, bodyText, results } = pageInfo
  const low = (bodyText || '').toLowerCase()
  const hasStrong = STRONG_MARKERS.some((m) => low.includes(m))
  const hasCaptcha = CAPTCHA_MARKERS.some((m) => low.includes(m))
  const urlSorry = /\/sorry|google\.com\/sorry/i.test(url || '')

  if (results && results.length > 0) return 'ok'
  if (urlSorry || hasStrong) return 'captcha'
  if (hasCaptcha) return 'captcha'
  return 'no_results'
}

function screenshotPath(dir, tag) {
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `google-${tag}-${Date.now()}.png`)
}

/**
 * Launch Chrome (headless or visible) on the dedicated persistent profile.
 * @param {{headless:boolean, log?:Function}} o
 */
/**
 * Remove stale Chrome singleton files (SingletonLock/Socket/Cookie) when no
 * live process is using the profile. A stale SingletonSocket can make a new
 * Chrome hang for a long time while it probes for the "existing instance".
 * (Linux-only: other platforms resolve stale locks fine on their own.)
 */
function cleanStaleSingleton(profile) {
  if (process.platform !== 'linux') return
  try {
    const inUse = fs.readdirSync('/proc').some((pid) => {
      if (!/^\d+$/.test(pid)) return false
      try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(profile)
      } catch {
        return false
      }
    })
    if (inUse) return
  } catch {
    return
  }
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.rmSync(path.join(profile, f), { force: true })
    } catch {
      /* ignore */
    }
  }
}

export async function launchChrome(o, env, opts) {
  const profile = opts.profileDir || defaultProfileDir()
  fs.mkdirSync(profile, { recursive: true })
  cleanStaleSingleton(profile)
  const log = o.log || (() => {})
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI,Translate',
    `--window-size=1280,1500`,
    // A normal desktop UA avoids some datacenter/automation heuristics.
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--disable-blink-features=AutomationControlled',
  ]
  if (opts.noSandbox !== false) args.push('--no-sandbox')
  if (o.headless) args.push('--headless=new', '--disable-gpu')
  log(`launching ${o.headless ? 'headless' : 'visible'} chrome (${resolveChromePath(env, opts)}) on profile ${profile}`)
  const browser = await puppeteer.launch({
    executablePath: resolveChromePath(env, opts),
    headless: o.headless,
    userDataDir: profile,
    dumpio: false,
    args,
    timeout: 30000,
  })
  return browser
}

/**
 * Take a screenshot of the current page, returning the saved file path.
 */
export async function capture(page, dir, tag) {
  try {
    const p = screenshotPath(dir, tag)
    await page.screenshot({ path: p, fullPage: false })
    return p
  } catch {
    return null
  }
}

/**
 * Read results from a page, or null if the page is gone (e.g. human closed the
 * window).
 */
async function tryRead(page) {
  try {
    return await readResults(page)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// AI Overview (Google's AI-generated answer + cited references)
// ---------------------------------------------------------------------------

/**
 * Extract Google's AI Overview (AI-generated answer) and the references it
 * cites, from an already-loaded SERP page.
 *
 * Returns `null` when the page has no AI Overview box. Otherwise:
 *   { present: true, text: '<answer>', references: [{ title, url }, …] }
 *
 * Best-effort by design: Google changes this UI frequently, so detection is
 * text-based (header marker) and references are any non-Google-internal link
 * inside the box. Never throws.
 */
export async function extractAiOverview(page, log = () => {}) {
  try {
    // Phase 1: detect the box (poll briefly — it can render a beat after the
    // results); if the answer is truncated ("Show more" / "Mostrar más"),
    // click it so the full text renders.
    let phase1 = null
    const detectDeadline = Date.now() + 3000
    for (;;) {
      phase1 = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
        const cands = [...document.querySelectorAll('div')].filter((d) =>
          /^(ai overview|resumen con ia|resumen generado con ia|respuesta con ia|responder con ia|ai-generated)/i.test(
            norm(d.innerText || ''),
          ),
        )
        cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        let box = cands[0]
        if (!box) return { found: false }
        for (let i = 0; i < 10 && box.parentElement; i++) {
          const p = box.parentElement
          if ((p.innerText || '').length >= (box.innerText || '').length + 150) box = p
          else break
        }
        let clickedMore = false
        for (const b of box.querySelectorAll('button,[role="button"],a[role="button"],div[role="button"]')) {
          const label = (norm(b.textContent) + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase()
          if (/(^|\s)(show more|see more|mostrar m[áa]s|ver m[áa]s|mostrar todo|show all)(\s|$)/.test(label)) {
            try {
              b.click()
              clickedMore = true
            } catch {
              /* ignore */
            }
            break
          }
        }
        return { found: true, clickedMore }
      }).catch(() => ({ found: false }))
      if (phase1.found || Date.now() >= detectDeadline) break
      await sleep(500)
    }
    if (!phase1 || !phase1.found) return null
    if (phase1.clickedMore) {
      await sleep(1500) // let the expanded answer render
    }

    // Phase 2: read the answer text and the cited references.
    // NOTE: no function arguments to evaluate() — this puppeteer build does not
    // serialize them, so the internal-host check is inlined here.
    const data = await page.evaluate(() => {
      const isGoogleInternalHost = (host) =>
        /(^|\.)(google|gstatic|ggpht|googlevideo)\.[a-z.]+$/i.test(host) ||
        host === 'accounts.google.com' ||
        host.endsWith('.googleapis.com')
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const box = (() => {
        const cands = [...document.querySelectorAll('div')].filter((d) =>
          /^(ai overview|resumen con ia|resumen generado con ia|respuesta con ia|responder con ia|ai-generated)/i.test(
            norm(d.innerText || ''),
          ),
        )
        cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)
        let box = cands[0]
        if (!box) return null
        for (let i = 0; i < 10 && box.parentElement; i++) {
          const p = box.parentElement
          if ((p.innerText || '').length >= (box.innerText || '').length + 150) box = p
          else break
        }
        return box
      })()
      if (!box) return null

      const full = box.innerText || ''

      // Variant where Google has no answer for the query — nothing to capture.
      if (/ai overview is not available|can'?t generate an? ?ai overview|no se puede generar un? ?resumen con ia|resumen con ia no disponible/i.test(full.slice(0, 400))) {
        return null
      }

      // --- Answer text: everything after the header, up to where the sources
      // section ("cited sites") begins. Google A/B-tests this UI, so two
      // strategies are used: an explicit "N sites" / "Mostrar todo" marker line,
      // or (fallback) the end of the answer just before the sources subtree. ---
      const lines = full.split('\n').map((l) => l.trim())
      let start = 0
      if (start < lines.length && /^(ai overview|resumen con ia|resumen generado con ia|respuesta con ia|responder con ia|ai-generated)/i.test(lines[start])) start += 1

      let endLine = -1
      for (let i = start; i < lines.length; i++) {
        if (/^\d+\s*(sites?|sitios|fuentes|websites)$/i.test(lines[i]) || /^(show all|mostrar todo|ver todo)$/i.test(lines[i])) {
          endLine = i
          break
        }
      }

      let cutChar = -1
      if (endLine < 0) {
        const isInternal = (h) =>
          /(^|\.)(google|gstatic|ggpht|googlevideo)\.[a-z.]+$/i.test(h) ||
          h === 'accounts.google.com' ||
          h.endsWith('.googleapis.com')
        const label = [...box.querySelectorAll('span,div,button,a')].find((e) => {
          const t = norm(e.textContent)
          return /^\d+\s*(sites?|sitios|fuentes|websites)$/i.test(t) && t.length < 25
        })
        if (label) {
          let section = label
          for (let i = 0; i < 8 && section.parentElement && section.parentElement !== box; i++) {
            section = section.parentElement
            let ext = 0
            for (const a of section.querySelectorAll('a[href]')) {
              const raw = a.getAttribute('href') || ''
              if (!/^https?:/i.test(raw)) continue
              try {
                if (!isInternal(new URL(raw, location.href).hostname)) ext++
              } catch {
                /* ignore */
              }
            }
            if (ext >= 3) break
          }
          const r = document.createRange()
          r.selectNodeContents(box)
          r.setEnd(section, 0)
          let win = r.toString().replace(/\s+/g, ' ').trim().slice(-60)
          win = win.replace(/([a-z])([A-Z])/g, '$1 $2') // fix textContent join boundaries
          for (let len = Math.min(60, win.length); len >= 20; len--) {
            const key = win.slice(-len)
            const idx = full.lastIndexOf(key) // last occurrence = true end of answer
            if (idx >= 0) {
              cutChar = idx + len
              break
            }
          }
        }
      }

      let end = lines.length
      if (endLine >= 0) {
        end = endLine
      } else if (cutChar > 0) {
        const candidate = full.slice(0, cutChar).split('\n').length
        if (candidate > start + 3) end = candidate // keep at least a few answer lines
      }
      const text = lines.slice(start, end).filter(Boolean).join('\n')

      // --- References: every non-Google-internal link in the box, deduped,
      // keeping the best (longest) title seen for each URL. ---
      const bestTitle = new Map() // url -> title
      const order = []
      for (const a of box.querySelectorAll('a[href]')) {
        const raw = a.getAttribute('href') || ''
        if (!/^https?:/i.test(raw)) continue
        let u
        try {
          u = new URL(raw, location.href)
        } catch {
          continue
        }
        if (isGoogleInternalHost(u.hostname)) continue
        if (/(^|\.)google\.[a-z.]+\/(search|url|goto)$/i.test(u.hostname + u.pathname)) continue
        const title = (a.innerText || '').replace(/\s+/g, ' ').trim()
        const key = u.href
        if (!bestTitle.has(key)) {
          bestTitle.set(key, '')
          order.push(key)
        }
        if (title && title.length > bestTitle.get(key).length) bestTitle.set(key, title)
      }
      const references = order.map((url) => ({
        title: (bestTitle.get(url) || '').slice(0, 120) || (() => {
          try {
            return new URL(url).hostname
          } catch {
            return url
          }
        })(),
        url,
      }))

      return { text, references }
    }).catch(() => null)

    if (!data || (!data.text && data.references.length === 0)) return null
    if (data.text) log(`Captured AI Overview answer (${data.text.length} chars, ${data.references.length} references)`)
    return {
      present: true,
      text: data.text || '',
      references: data.references || [],
    }
  } catch (err) {
    log(`AI Overview extraction failed: ${err && err.message ? err.message : String(err)}`)
    return null
  }
}

/**
 * Run a Google search using the local Chrome.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxResults=8]
 * @param {number} [opts.verifyTimeoutMs=150000]  how long to wait for the human to solve the CAPTCHA
 * @param {boolean} [opts.headless=true]          whether the first attempt is headless
 * @param {string} [opts.gl='us']                 Google region
 * @param {string} [opts.hl='en']                 Google language
 * @param {string} [opts.chromePath]              Chrome executable
 * @param {string} [opts.profileDir]              persistent profile dir
 * @param {boolean} [opts.noSandbox=true]
 * @param {boolean} [opts.autoVerify=true]        if false, never open a visible window (just report)
 * @param {Function} [opts.log]                   progress logger (stderr in CLI/server)
 * @returns {Promise<SearchOutcome>}
 */
export async function googleSearch(query, opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const maxResults = opts.maxResults ?? 8
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 150_000
  const autoVerify = opts.autoVerify !== false
  const firstHeadless = opts.headless !== false
  const signal = opts.signal
  const profileDir = opts.profileDir || defaultProfileDir()
  const shotDir = path.join(profileDir, 'screenshots')
  const url = searchUrl(query, { gl: opts.gl, hl: opts.hl })
  const chromeOpts = { chromePath: opts.chromePath, profileDir, noSandbox: opts.noSandbox }

  // --- Attempt 1: headless by default (fast path; also benefits from a prior verification) ---
  let usedVisibleWindow = false
  let browser = await launchChrome({ headless: firstHeadless }, env, chromeOpts)
  try {
    if (signal?.aborted) throw new Error('search aborted')
    let page = (await browser.pages())[0] || (await browser.newPage())
    log(`searching (${firstHeadless ? 'headless' : 'visible'}): ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    // Give the results (or a verification interstitial) a moment to settle —
    // Google sometimes renders them a beat after domcontentloaded. Poll until
    // the page classifies as ok/captcha or the settle window elapses.
    const settleDeadline = Date.now() + 8000
    let info = null
    let state = 'no_results'
    for (;;) {
      info = (await tryRead(page)) || { url: page.url(), bodyText: '', results: [] }
      state = classify(info)
      if (state !== 'no_results' || Date.now() >= settleDeadline) break
      await sleep(1000)
    }

    // --- CAPTCHA: ask the human via a visible window ---
    if (state === 'captcha') {
      const shot = await capture(page, shotDir, 'captcha')
      if (!autoVerify) {
        return {
          status: 'verification_required',
          query,
          url,
          screenshot: shot,
          message:
            'Google requires human verification (CAPTCHA) and autoVerify is disabled. ' +
            (shot ? `Screenshot saved to ${shot}. ` : '') +
            'Run with autoVerify=true (or run the CLI) so a visible Chrome window can be opened for the human to solve.',
        }
      }
      log('Google served a human-verification page. Closing headless browser and opening a VISIBLE Chrome window for the human to solve it.')
      await browser.close()
      browser = null

      // --- Attempt 2: visible window; the human solves the CAPTCHA ---
      usedVisibleWindow = true
      browser = await launchChrome({ headless: false }, env, chromeOpts)
      page = (await browser.pages())[0] || (await browser.newPage())
      log(`opening verification page in a visible window: ${url}`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})

      const deadline = Date.now() + verifyTimeoutMs
      let solved = false
      let lastInfo = null
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('search aborted')
        info = await tryRead(page)
        if (!info) break // page/browser gone
        lastInfo = info
        if (classify(info) === 'ok') {
          solved = true
          break
        }
        log(`waiting for the human to complete verification… (${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s left)`)
        await sleep(1500)
      }

      if (!solved) {
        const shot2 = await capture(page, shotDir, 'timeout')
        await browser.close()
        browser = null
        return {
          status: 'verification_required',
          query,
          url: lastInfo ? lastInfo.url : url,
          screenshot: shot2,
          message:
            `Google's human verification was not completed within ${Math.round(verifyTimeoutMs / 1000)}s. ` +
            (shot2 ? `Latest screenshot saved to ${shot2}. ` : '') +
            'Please complete the verification in the opened Chrome window, then run the search again — the verified session is kept in the profile, so it usually succeeds next time.',
        }
      }
      info = lastInfo
      state = 'ok'
    }

    if (state !== 'ok') {
      // Reached here without results and without a detected CAPTCHA: the page
      // was something unexpected (often an undetected verification interstitial).
      const shot = await capture(page, shotDir, 'no-results')
      return {
        status: 'no_results',
        query,
        url: info.url,
        screenshot: shot,
        message:
          'No organic results were extracted from the rendered page. ' +
          (shot ? `A screenshot was saved to ${shot} so you can see what Google served. ` : '') +
          'It may be a verification interstitial that was not detected — if so, re-run the search ' +
          'with autoVerify enabled so a visible window can be opened for the human to verify.',
      }
    }

    const results = (info.results || []).slice(0, maxResults)
    // Turn Google's redirect wrappers into real destination URLs.
    await resolveLinks(results, resolveChromePath(env, chromeOpts), log)
    // Capture Google's AI-generated answer + cited references, when present.
    let aiOverview = null
    if (opts.aiOverview !== false) {
      aiOverview = await extractAiOverview(page, log)
    }
    const outcome = {
      status: 'ok',
      query,
      url: info.url,
      resultCount: results.length,
      results,
      verifiedViaHuman: usedVisibleWindow,
      aiOverview,
    }
    return outcome
  } finally {
    if (browser) {
      try {
        await browser.close()
      } catch {
        /* already closed */
      }
    }
  }
}

export default googleSearch
