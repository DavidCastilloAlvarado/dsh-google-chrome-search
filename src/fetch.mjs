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
]

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
 * Returns a page outcome (see fetchPage return shape).
 */
async function fetchUrlOnPage(page, url, o) {
  const { maxChars, includeHtml, wantShot, timeoutMs, shotDir, log } = o
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
  const finalUrl = page.url() || url
  await settlePage(page)
  const raw = await extractFromPage(page)

  if (looksBlocked(finalUrl, raw.title, raw.fullText.slice(0, 500))) {
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

  const source = raw.readable ? raw.contentText : raw.fullText
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
  if (includeHtml) {
    const html = raw.readable ? raw.contentHtml : await page.content().catch(() => '')
    outcome.html = cap(html, maxChars).text
  }
  if (wantShot) outcome.screenshot = await capture(page, shotDir, 'page')
  log(`extracted ${source.length} chars from ${finalUrl} (${raw.readable ? 'readable article' : 'full page text'})`)
  return outcome
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
 * @param {Function} [opts.log]
 * @returns {Promise<object>} outcome with status ok | error | blocked
 */
export async function fetchPage(url, opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const profileDir = opts.profileDir || defaultProfileDir()
  const shotDir = path.join(profileDir, 'screenshots')
  const chromeOpts = { chromePath: opts.chromePath, profileDir, noSandbox: opts.noSandbox }

  let browser
  try {
    browser = await launchChrome({ headless: opts.headless !== false }, env, chromeOpts)
  } catch (err) {
    return {
      status: 'error',
      url,
      message: `Could not launch Chrome: ${err && err.message ? err.message : String(err)}`,
    }
  }
  try {
    const page = (await browser.pages())[0] || (await browser.newPage())
    log(`fetching: ${url}`)
    return await fetchUrlOnPage(page, url, {
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

  const pages = []
  try {
    for (const t of targets) {
      log(`fetching result: ${t.link}`)
      const page = await browser.newPage().catch(() => null)
      if (!page) break
      try {
        const p = await fetchUrlOnPage(page, t.link, {
          maxChars: opts.maxChars ?? 8000,
          includeHtml: false,
          wantShot: false,
          timeoutMs: 20000,
          shotDir,
          log,
        })
        pages.push({ url: t.link, title: t.title, snippet: t.snippet, ...p })
      } catch (err) {
        pages.push({
          url: t.link, title: t.title, snippet: t.snippet,
          status: 'error', message: `Fetch failed: ${err && err.message ? err.message : String(err)}`,
        })
      } finally {
        await page.close().catch(() => {})
      }
    }
  } finally {
    try {
      await browser.close()
    } catch {
      /* already closed */
    }
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
