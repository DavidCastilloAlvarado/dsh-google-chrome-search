/**
 * dsh-google-chrome-search — page rendering & content extraction.
 *
 * `fetchPage(url, opts)` renders a single URL in the local Chrome (same
 * dedicated profile as the search) and extracts its readable main content
 * using Mozilla Readability, run inside the live page (no jsdom needed).
 *
 * `searchAndFetch(query, opts)` combines both: runs a Google search, then
 * renders the top N result pages sequentially (one browser, one page at a
 * time) and returns per-page extracted content.
 *
 * NOTE: Chrome allows only one process per user-data-dir, so search and
 * fetch must run sequentially against the same profile — callers (the MCP
 * server) serialize their calls accordingly.
 *
 * Public API: `fetchPage(url, options)`, `searchAndFetch(query, options)`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  googleSearch,
  defaultProfileDir,
  resolveChromePath,
  launchChrome,
  capture,
} from './search.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Locate the browserify/UMD build of Readability for in-page injection.
const requireModule = createRequire(import.meta.url)
let READABILITY_JS = null
try {
  READABILITY_JS = requireModule.resolve('@mozilla/readability/Readability.js')
  if (!fs.existsSync(READABILITY_JS)) READABILITY_JS = null
} catch {
  READABILITY_JS = null
}

/** Best-effort markers for anti-bot / access-control interstitials. */
const BLOCK_MARKERS = [
  'just a moment',
  'attention required',
  'are you a robot',
  'unusual traffic',
  'enable javascript and cookies',
  'please enable javascript',
  'cf-browser-verification',
  'access denied',
  'request blocked',
  'prove your humanity',
  'complete the challenge below',
  'not for bots',
]

/** Hostname without the www prefix, or null if the URL cannot be parsed. */
function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function looksBlocked(finalUrl, title, bodyHead) {
  const t = `${title || ''} ${bodyHead || ''}`.toLowerCase()
  return BLOCK_MARKERS.some((m) => t.includes(m))
}

/** Cap a string at n chars, reporting whether it was truncated. */
function cap(s, n) {
  const text = s || ''
  if (n > 0 && text.length > n) {
    return { text: `${text.slice(0, n)}\n… [truncated — ${text.length - n} more characters]`, truncated: true }
  }
  return { text, truncated: false }
}

/**
 * Wait for the page to be ready: poll for document.readyState === 'complete'
 * (up to 6 s), then give late SPA content a short settle window.
 */
async function settlePage(page) {
  const deadline = Date.now() + 6000
  for (;;) {
    const rs = await page.evaluate(() => document.readyState).catch(() => 'complete')
    if (rs === 'complete' || Date.now() >= deadline) break
    await sleep(300)
  }
  await sleep(1000)
}

/**
 * Extract readable content from an already-loaded page.
 * Injects Readability into the page and runs it on a clone of the live DOM.
 * Falls back to the full body text when no article is found.
 */
async function extractFromPage(page) {
  if (READABILITY_JS) {
    try {
      await page.addScriptTag({ path: READABILITY_JS })
    } catch {
      /* injection failed — fall back to full text */
    }
  }
  const empty = {
    title: '', url: '', fullText: '', readable: false,
    contentText: '', contentHtml: '', byline: '', siteName: '', excerpt: '',
  }
  try {
    return await page.evaluate(() => {
      const doc = document
      let article = null
      try {
        if (typeof window.Readability === 'function') {
          const clone = doc.cloneNode(true)
          const r = new window.Readability(clone).parse()
          if (r && r.textContent && r.textContent.trim()) article = r
        }
      } catch {
        article = null
      }
      return {
        title: doc.title || '',
        url: location.href,
        fullText: (doc.body && doc.body.innerText) || '',
        readable: !!article,
        contentText: article ? article.textContent || '' : '',
        contentHtml: article ? article.content || '' : '',
        byline: article ? article.byline || '' : '',
        siteName: article ? article.siteName || '' : '',
        excerpt: article ? article.excerpt || '' : '',
      }
    })
  } catch {
    return empty
  }
}

/**
 * Fetch, render and extract one URL on an already-open page.
 * With `o.navigate === false` the page is assumed to already be loaded
 * (used after a human-verification round).
 * Returns a page outcome (see fetchPage return shape).
 */
async function fetchUrlOnPage(page, url, o) {
  const { maxChars, includeHtml, wantShot, timeoutMs, shotDir, log } = o
  if (o.navigate !== false) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    } catch (err) {
      return {
        status: 'error',
        url,
        finalUrl: page.url() || url,
        message: `Navigation failed: ${err && err.message ? err.message : String(err)}`,
      }
    }
  }
  const finalUrl = page.url() || url
  if (o.navigate !== false) await settlePage(page)
  const raw = await extractFromPage(page)

  // An off-host redirect to a short page (e.g. reddit.com bouncing to a
  // support.reddithelp.com form) is a network-level bot block — report it as
  // blocked instead of extracting the form as "content".
  const offHost = hostOf(finalUrl) && hostOf(url) && hostOf(finalUrl) !== hostOf(url)
  const blockedText = looksBlocked(finalUrl, raw.title, raw.fullText.slice(0, 500))
  if (offHost && (blockedText || (raw.fullText || '').length < 1000)) {
    const shot = wantShot ? await capture(page, shotDir, 'blocked') : null
    return {
      status: 'blocked',
      url,
      finalUrl,
      title: raw.title,
      text: raw.fullText.slice(0, 300),
      screenshot: shot,
      message:
        `The site redirected to ${hostOf(finalUrl)} (typically a bot-block/support page). ` +
        'This machine network/IP appears to be blocked by the site — verification in a ' +
        'window usually cannot fix it. Try a different source for the same topic, or run ' +
        'from a residential connection.',
    }
  }

  if (blockedText) {
    const shot = wantShot ? await capture(page, shotDir, 'blocked') : null
    return {
      status: 'blocked',
      url,
      finalUrl,
      title: raw.title,
      text: raw.fullText.slice(0, 300),
      screenshot: shot,
      message:
        'The site served an anti-bot / access-control page (headless browser detected). ' +
        'Try the page in a normal browser, or fetch a different source for the same topic.',
    }
  }

  // Compact the text: strip trailing line whitespace (HTML indentation from
  // JS frontends like Reddit) and collapse blank-line runs. Leading
  // indentation (e.g. code blocks) is preserved.
  const source = ((raw.readable ? raw.contentText : raw.fullText) || '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const text = cap(source, maxChars)
  const outcome = {
    status: 'ok',
    url,
    finalUrl,
    title: raw.title,
    byline: raw.byline,
    siteName: raw.siteName,
    readable: raw.readable,
    text: text.text,
    truncated: text.truncated,
    textLength: source.length,
    screenshot: null,
  }
  // A near-empty shell is the shape of a soft wall — keep a screenshot of it so
  // the caller can show it to the human / include it in the blocked report.
  if (isWall(outcome)) {
    outcome.screenshot = await capture(page, shotDir, 'wall').catch(() => null)
  }
  if (includeHtml) {
    const html = raw.readable ? raw.contentHtml : await page.content().catch(() => '')
    outcome.html = cap(html, maxChars).text
  }
  if (wantShot) outcome.screenshot = await capture(page, shotDir, 'page')
  log(`extracted ${source.length} chars from ${finalUrl} (${raw.readable ? 'readable article' : 'full page text'})`)
  return outcome
}

/**
 * A "soft wall": the page rendered but yielded no usable text — the typical
 * shape of an anti-bot slider challenge (DataDome & co.) served in an empty
 * shell. Marker-based detection (looksBlocked) misses these because the
 * challenge is drawn in an isolated frame.
 */
/**
 * Weak signals that a short, marker-free page is a bot-challenge shell rather
 * than a genuinely short legitimate page (a one-paragraph status page, etc.).
 */
const WALL_HINTS = [
  'human', 'robot', 'captcha', 'challenge', 'verification', 'verify',
  'checking', 'please wait', 'security check', 'blocked', 'unusual',
  'unavailable', 'access to this', 'not for bots',
]

function isWall(p) {
  if (p.status !== 'ok') return false
  const text = (p.text || '').trim()
  if (text.length >= 300) return false
  // A near-empty shell (< 20 chars) is still treated as a wall: the challenge
  // is usually drawn in an isolated frame and yields no text at all.
  if (text.length < 20) return true
  return WALL_HINTS.some((h) => text.toLowerCase().includes(h))
}

/**
 * Hand a walled page to the human: open a VISIBLE Chrome window (same
 * dedicated profile) on the page, wait up to verifyTimeoutMs for the human
 * to pass the challenge (page text appearing), then extract the content.
 * The trusted session cookie persists in the profile, so later pages of the
 * same site usually pass headless.
 */
async function humanVerify(url, env, chromeOpts, shotDir, log, verifyTimeoutMs, extra = {}) {
  const { maxChars = 8000, wantShot = false } = extra
  let browser
  try {
    browser = await launchChrome({ headless: false, log }, env, chromeOpts)
  } catch (err) {
    return {
      status: 'blocked',
      url,
      message:
        `The page is behind a human-verification challenge, but the visible Chrome ` +
        `window could not be opened: ${err && err.message ? err.message : String(err)}`,
    }
  }
  try {
    const page = (await browser.pages())[0] || (await browser.newPage())
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    } catch {
      /* the wall may intercept navigation — the challenge still renders */
    }
    // Off-host redirect = network-level block; nothing the human can do in
    // this window (e.g. Reddit bouncing to its support form). Report it now
    // instead of waiting the full verify timeout.
    if (hostOf(page.url() || url) && hostOf(page.url() || url) !== hostOf(url)) {
      const shot = await capture(page, shotDir, 'wall').catch(() => null)
      return {
        status: 'blocked',
        url,
        finalUrl: page.url(),
        screenshot: shot,
        message:
          `The site immediately redirected to ${hostOf(page.url())} (a bot-block/support page). ` +
          "This machine's network/IP appears to be blocked by the site — solving anything in " +
          'the window cannot fix it. Try a different source for the same topic, or run from a ' +
          'residential connection.',
      }
    }
    log(`waiting up to ${verifyTimeoutMs}ms for the human to pass the challenge in the visible window`)
    const deadline = Date.now() + verifyTimeoutMs
    let solved = false
    while (Date.now() < deadline) {
      await sleep(2000)
      const st = await page
        .evaluate(() => ((document.body && document.body.innerText) || '').length)
        .catch(() => null)
      if (st === null) break // the human closed the window
      if (st > 300) {
        solved = true
        break
      }
    }
    if (!solved) {
      const shot = await capture(page, shotDir, 'wall').catch(() => null)
      return {
        status: 'blocked',
        url,
        finalUrl: page.url() || url,
        screenshot: shot,
        message:
          'The page is behind a human-verification challenge (anti-bot) and it was not ' +
          'completed in time. A visible Chrome window was opened on the page — if the human ' +
          'solves the challenge, retry: the trusted session is kept in the profile.',
      }
    }
    await settlePage(page)
    if (hostOf(page.url() || url) && hostOf(page.url() || url) !== hostOf(url)) {
      // The "challenge" turned out to be an off-host block redirect.
      const shot = await capture(page, shotDir, 'wall').catch(() => null)
      return {
        status: 'blocked',
        url,
        finalUrl: page.url(),
        screenshot: shot,
        message:
          `After the verification attempt the site redirected to ${hostOf(page.url())} ` +
          '(a bot-block/support page). This machine network/IP appears to be blocked by the ' +
          'site. Try a different source for the same topic, or run from a residential ' +
          'connection.',
      }
    }
    const outcome = await fetchUrlOnPage(page, url, {
      navigate: false,
      maxChars,
      includeHtml: false,
      wantShot,
      timeoutMs: 20000,
      shotDir,
      log,
    })
    if (outcome.status === 'ok') outcome.verifiedViaHuman = true
    return outcome
  } finally {
    try {
      await browser.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Render a URL with the local Chrome and extract its readable content.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number}  [opts.maxChars=8000]     max characters of text to return
 * @param {boolean} [opts.includeHtml=false] also return extracted HTML
 * @param {boolean} [opts.screenshot=false]  also capture a page screenshot
 * @param {number}  [opts.timeoutMs=20000]   navigation timeout
 * @param {string}  [opts.chromePath]
 * @param {string}  [opts.profileDir]
 * @param {boolean} [opts.headless=true]
 * @param {boolean} [opts.noSandbox=true]
 * @param {boolean} [opts.autoVerify=true]   if a site walls the page, open a visible window for the human
 * @param {number}  [opts.verifyTimeoutMs=150000] how long to wait for the human to pass the challenge
 * @param {Function} [opts.log]
 * @returns {Promise<object>} outcome with status ok | error | blocked
 *   (`verifiedViaHuman: true` when a human passed the challenge)
 */
export async function fetchPage(url, opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const profileDir = opts.profileDir || defaultProfileDir()
  const shotDir = path.join(profileDir, 'screenshots')
  const chromeOpts = { chromePath: opts.chromePath, profileDir, noSandbox: opts.noSandbox }

  let browser
  try {
    browser = await launchChrome({ headless: opts.headless !== false, log }, env, chromeOpts)
  } catch (err) {
    return {
      status: 'error',
      url,
      message: `Could not launch Chrome: ${err && err.message ? err.message : String(err)}`,
    }
  }
  let outcome
  try {
    const page = (await browser.pages())[0] || (await browser.newPage())
    log(`fetching: ${url}`)
    outcome = await fetchUrlOnPage(page, url, {
      maxChars: opts.maxChars ?? 8000,
      includeHtml: opts.includeHtml === true,
      wantShot: opts.screenshot === true,
      timeoutMs: opts.timeoutMs ?? 20000,
      shotDir,
      log,
    })
  } finally {
    try {
      await browser.close()
    } catch {
      /* already closed */
    }
  }

  // Soft wall (anti-bot slider served in an empty shell) → hand it to the
  // human in a visible window, like the Google CAPTCHA fallback. The headless
  // browser is closed by now, so the visible one can take the profile.
  if (isWall(outcome)) {
    if (opts.autoVerify !== false) {
      log('anti-bot wall detected — opening a visible window for the human')
      outcome = await humanVerify(url, env, chromeOpts, shotDir, log, opts.verifyTimeoutMs ?? 150000, {
        maxChars: opts.maxChars ?? 8000,
        wantShot: opts.screenshot === true,
      })
    } else {
      outcome = {
        ...outcome,
        status: 'blocked',
        message:
          'The page is behind a human-verification challenge (anti-bot), and verification is ' +
          'disabled (autoVerify is off), so no visible window was opened. Re-run with ' +
          'verification enabled (the default) to let the human pass it, or try a different ' +
          'source for the same topic.',
      }
    }
  }
  return outcome
}

/**
 * Run a Google search, then render and extract the top N result pages.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number}  [opts.maxResults=5]    search results to retrieve
 * @param {number}  [opts.fetchTop=3]      how many of them to render (max 5)
 * @param {number}  [opts.maxChars=8000]   max characters of text per page
 * @param {string}  [opts.gl='us']
 * @param {string}  [opts.hl='en']
 * @param {number}  [opts.verifyTimeoutMs]
 * @param {boolean} [opts.autoVerify=true]
 * @param {string}  [opts.chromePath]
 * @param {string}  [opts.profileDir]
 * @param {Function} [opts.log]
 * @returns {Promise<object>} outcome with status ok | verification_required | no_results,
 *   plus `pages: [{ url, title, snippet, status, finalUrl, text, ... }]` when ok
 */
export async function searchAndFetch(query, opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const maxResults = opts.maxResults ?? 5
  const fetchTop = Math.min(opts.fetchTop ?? 3, 5)
  const profileDir = opts.profileDir || defaultProfileDir()
  const shotDir = path.join(profileDir, 'screenshots')

  const search = await googleSearch(query, {
    maxResults,
    gl: opts.gl,
    hl: opts.hl,
    verifyTimeoutMs: opts.verifyTimeoutMs,
    autoVerify: opts.autoVerify,
    chromePath: opts.chromePath,
    profileDir,
    log,
  })
  if (search.status !== 'ok') {
    return {
      status: search.status,
      query,
      url: search.url,
      message: search.message,
      screenshot: search.screenshot,
    }
  }

  const targets = search.results.slice(0, fetchTop)
  const chromeOpts = { chromePath: opts.chromePath, profileDir, noSandbox: opts.noSandbox }
  let browser
  try {
    browser = await launchChrome({ headless: true }, env, chromeOpts)
  } catch (err) {
    return {
      status: 'ok',
      query,
      resultCount: search.results.length,
      searchUrl: search.url,
      verifiedViaHuman: search.verifiedViaHuman,
      pages: targets.map((t) => ({
        url: t.link, title: t.title, snippet: t.snippet,
        status: 'error', message: `Could not launch Chrome: ${err && err.message ? err.message : String(err)}`,
      })),
    }
  }

  const autoVerify = opts.autoVerify !== false
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 150000
  const pages = []
  let sharedBrowser = browser
  try {
    for (const t of targets) {
      log(`fetching result: ${t.link}`)
      const page = await sharedBrowser.newPage().catch(() => null)
      if (!page) break
      let p
      try {
        p = await fetchUrlOnPage(page, t.link, {
          maxChars: opts.maxChars ?? 8000,
          includeHtml: false,
          wantShot: false,
          timeoutMs: 20000,
          shotDir,
          log,
        })
      } catch (err) {
        p = {
          status: 'error',
          message: `Fetch failed: ${err && err.message ? err.message : String(err)}`,
        }
      } finally {
        await page.close().catch(() => {})
      }
      if (isWall(p) && autoVerify) {
        log(`wall on ${t.link} — opening a visible window for the human`)
        // One Chrome process per profile: hand the profile to the visible
        // window while the human verifies, then re-open it for the rest.
        try {
          await sharedBrowser.close()
        } catch {
          /* already closed */
        }
        sharedBrowser = null
        p = await humanVerify(t.link, env, chromeOpts, shotDir, log, verifyTimeoutMs, {
          maxChars: opts.maxChars ?? 8000,
        })
        try {
          sharedBrowser = await launchChrome({ headless: true }, env, chromeOpts)
        } catch {
          sharedBrowser = null
        }
        if (!sharedBrowser) break // cannot render the remaining pages
      } else if (isWall(p)) {
        p = {
          ...p,
          status: 'blocked',
          message:
            'The page is behind a human-verification challenge (anti-bot), and verification ' +
            'is disabled (autoVerify is off). Re-run with verification enabled (the default) ' +
            'to let the human pass it, or try a different source for the same topic.',
        }
      }
      pages.push({ url: t.link, title: t.title, snippet: t.snippet, ...p })
    }
  } finally {
    if (sharedBrowser) await sharedBrowser.close().catch(() => {})
  }

  return {
    status: 'ok',
    query,
    resultCount: search.results.length,
    searchUrl: search.url,
    verifiedViaHuman: search.verifiedViaHuman,
    pages,
  }
}
