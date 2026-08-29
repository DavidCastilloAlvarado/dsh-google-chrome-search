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
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
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

// ---------------------------------------------------------------------------
// PDF handling
//
// Chrome renders PDFs with the built-in PDFium viewer, whose page is an EMPTY
// document (no body text, no embed/iframe, no title) in both headless-new and
// visible mode. That empty shape is exactly what the wall heuristics mistake
// for an anti-bot challenge — so a PDF is detected explicitly and never falls
// through to the wall / human-verify path. When the PDF is detected, its bytes
// are fetched with the browser session's own cookies (a plain GET carries the
// verification cookie the human earned) and saved to the profile's downloads
// dir; PDFs cannot be text-extracted by Readability.
// ---------------------------------------------------------------------------

const PDF_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** True if the URL path ends in .pdf (case-insensitive). */
function isPdfUrl(u) {
  try {
    return decodeURIComponent(new URL(u).pathname).toLowerCase().endsWith('.pdf')
  } catch {
    return false
  }
}

/** A safe file name for a downloaded PDF, derived from the URL. */
function pdfFileName(u, fallback) {
  try {
    const raw = decodeURIComponent(new URL(u).pathname).split('/').filter(Boolean).pop() || ''
    const name = (raw || 'document').replace(/[^\w.-]+/g, '-').slice(0, 120)
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`
  } catch {
    return fallback
  }
}

/** Write the PDF bytes into `dir` (unique name on collision), return the path. */
function savePdfFile(dir, name, buf) {
  fs.mkdirSync(dir, { recursive: true })
  let p = path.join(dir, name)
  let i = 1
  while (fs.existsSync(p)) {
    p = path.join(dir, `${path.basename(name, '.pdf')}-${i++}.pdf`)
  }
  fs.writeFileSync(p, buf)
  return p
}

/**
 * Download the PDF at `pdfUrl` using the page's own session cookies, so a
 * verification cookie the human earned is sent along. Returns
 * { ok: true, path, size } or { ok: false, reason }.
 */
async function downloadPdf(page, pdfUrl, downloadDir, log) {
  try {
    const cookies = await page.cookies(pdfUrl).catch(() => [])
    const headers = {
      'user-agent': PDF_UA,
      accept: 'application/pdf,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    }
    if (cookies.length > 0) headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const cur = page.url() || ''
    if (cur && /^https?:/.test(cur) && cur !== pdfUrl) headers.referer = cur
    const res = await fetch(pdfUrl, { headers, redirect: 'follow' })
    const buf = Buffer.from(await res.arrayBuffer())
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    if (!buf.subarray(0, 5).toString('latin1').startsWith('%PDF')) {
      return { ok: false, reason: 'the server did not return a PDF (likely still a challenge page)' }
    }
    const p = savePdfFile(downloadDir, pdfFileName(pdfUrl, `document-${Date.now()}.pdf`), buf)
    log(`downloaded PDF (${buf.length} bytes) -> ${p}`)
    return { ok: true, path: p, size: buf.length }
  } catch (err) {
    log(`PDF download failed: ${err && err.message ? err.message : String(err)}`)
    return { ok: false, reason: err && err.message ? err.message : String(err) }
  }
}

// --- PDF page → image rendering (the primary read path) -------------------
//
// The agent reads page images (no text extraction — immune to weird
// encodings and scanned pages). Rendering is tried in three tiers:
//   1. system `pdftoppm` (poppler-utils) — best, zero npm deps;
//   2. `pdf-to-img` (optional npm dep: pdfjs + node-canvas) — covers
//      machines without poppler (e.g. a fresh Mac);
//   3. screenshots of Chrome's PDFium viewer — always works, no deps.
//    (The viewer can only be turned with a real click + PageDown: key
//     events without focus are ignored and leave it stuck on page 1.)

let pdftoppmOk = null
function hasPdftoppm() {
  if (pdftoppmOk === null) {
    try {
      execFileSync('pdftoppm', ['-v'], { stdio: 'ignore', timeout: 5000 })
      pdftoppmOk = true
    } catch {
      pdftoppmOk = false
    }
  }
  return pdftoppmOk
}

let pdfToImgMod = null
let pdfToImgTried = false
async function loadPdfToImg() {
  if (pdfToImgTried) return pdfToImgMod
  pdfToImgTried = true
  try {
    pdfToImgMod = await import('pdf-to-img')
  } catch {
    pdfToImgMod = null // optional dep missing or native build failed
  }
  return pdfToImgMod
}

/**
 * Render the first `n` pages of a downloaded PDF file to PNG images in
 * `shotDir` (named `pdf-<ts>-p<k>.png`). Returns [] when no renderer is
 * available (the caller then falls back to viewer screenshots).
 */
async function pdfToPageImages(pdfPath, n, shotDir, log) {
  const count = Math.max(1, Math.min(Math.trunc(Number(n)) || 2, 16))
  const ts = Date.now()
  fs.mkdirSync(shotDir, { recursive: true })

  if (hasPdftoppm()) {
    const prefix = path.join(shotDir, `pdf-${ts}`)
    const ok = await new Promise((resolve) => {
      execFile(
        'pdftoppm',
        ['-png', '-r', '150', '-f', '1', '-l', String(count), pdfPath, prefix],
        { timeout: 60000 },
        (err) => resolve(!err),
      )
    })
    if (ok) {
      const base = path.basename(prefix)
      const files = fs
        .readdirSync(shotDir)
        .filter((f) => f.startsWith(base + '-') && f.endsWith('.png'))
        .sort((a, b) => Number(a.slice(base.length + 1, -4)) - Number(b.slice(base.length + 1, -4)))
      const shots = files.map((f, i) => {
        const dest = path.join(shotDir, `pdf-${ts}-p${i + 1}.png`)
        fs.renameSync(path.join(shotDir, f), dest)
        return dest
      })
      if (shots.length > 0) {
        log(`rendered ${shots.length} PDF page image(s) with pdftoppm`)
        return shots
      }
    }
    log('pdftoppm did not render the PDF — trying pdf-to-img')
  }

  const mod = await loadPdfToImg()
  if (mod) {
    let doc
    try {
      doc = await mod.pdf(pdfPath, { scale: 2 }) // 72 DPI x 2 ≈ 144
      const shots = []
      for (let k = 1; k <= count; k++) {
        const buf = await doc.getPage(k)
        if (!buf) break // beyond the last page
        const dest = path.join(shotDir, `pdf-${ts}-p${k}.png`)
        fs.writeFileSync(dest, buf)
        shots.push(dest)
      }
      if (shots.length > 0) {
        log(`rendered ${shots.length} PDF page image(s) with pdf-to-img`)
        return shots
      }
    } catch (err) {
      log(`pdf-to-img failed: ${err && err.message ? err.message : err}`)
    } finally {
      try {
        doc && doc.destroy()
      } catch {
        /* ignore */
      }
    }
  }
  return []
}

/**
 * Fallback tier: screenshot the PDF pages as shown in Chrome's PDFium
 * viewer. The viewer needs a real click to take keyboard focus before
 * PageDown turns a page (otherwise it stays stuck on page 1); a
 * pixel-identical screenshot means the document has no more pages.
 * Returns the list of image paths (possibly empty).
 */
async function viewerPageImages(page, shotDir, n, log) {
  const count = Math.max(1, Math.min(Math.trunc(Number(n)) || 2, 16))
  const ts = Date.now()
  fs.mkdirSync(shotDir, { recursive: true })
  const shots = []
  let prevHash = null
  for (let k = 1; k <= count; k++) {
    if (k > 1) {
      await page.mouse.click(400, 300).catch(() => {})
      await sleep(200)
      await page.keyboard.press('PageDown').catch(() => {})
      await sleep(800)
    }
    const p = path.join(shotDir, `pdf-${ts}-p${k}.png`)
    try {
      await page.screenshot({ path: p, fullPage: false })
    } catch {
      break // page gone (e.g. the human closed the window)
    }
    const hash = createHash('sha1').update(fs.readFileSync(p)).digest('hex')
    if (prevHash !== null && hash === prevHash) {
      fs.rmSync(p, { force: true })
      break // viewer did not turn — the document has no more pages
    }
    prevHash = hash
    shots.push(p)
    log(`captured PDF viewer page ${k}/${count} -> ${p}`)
  }
  return shots
}

/**
 * Build the outcome object for a URL that turned out to be a PDF document.
 * `shots` are the paths of the captured page images (PDFs are read as images,
 * not text-extracted); `dl` is the full-file download (lossless fallback for
 * documents longer than the captured pages / exact text).
 */
function pdfOutcome({ url, finalUrl, dl, shots = [], verifiedViaHuman = false }) {
  let message
  if (dl.ok && shots.length > 0) {
    message =
      `This URL is a PDF document — to read its contents, read the page images ` +
      `(as images, no text extraction needed): ${shots.join(', ')}. ` +
      `The full file is also saved to: ${dl.path} (${(dl.size / 1024).toFixed(1)} KB) — ` +
      'use it (e.g. with a PDF tool) for pages beyond the captured ones or exact text.'
  } else if (dl.ok) {
    message =
      `This URL is a PDF document, not a web page — its text cannot be extracted here. ` +
      `The file was downloaded to: ${dl.path} (${(dl.size / 1024).toFixed(1)} KB). ` +
      'Read the file directly (e.g. with a PDF tool) to use its contents.'
  } else if (shots.length > 0) {
    message =
      `This URL is a PDF document — read its pages as images: ${shots.join(', ')}. ` +
      `Automatic download of the full file failed (${dl.reason}).`
  } else {
    message =
      `This URL is a PDF document, not a web page — its text cannot be extracted here. ` +
      `Automatic download failed (${dl.reason}); open the URL in a browser to view the document.`
  }
  return {
    status: 'ok',
    url,
    finalUrl,
    title: '',
    pdf: true,
    pdfPath: dl.ok ? dl.path : null,
    pdfSize: dl.ok ? dl.size : null,
    pdfShots: shots,
    readable: false,
    text: '',
    truncated: false,
    textLength: 0,
    verifiedViaHuman,
    screenshot: null,
    message,
  }
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
  let navResponse = null
  if (o.navigate !== false) {
    try {
      navResponse = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
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

  // --- PDF detection (before the wall / block heuristics): a PDF must never
  // be mistaken for an anti-bot challenge. The main-document response
  // content-type is authoritative; when it is unavailable (no response
  // captured, or navigate:false after a human-verification round), the .pdf
  // URL extension plus the empty PDFium-viewer document is the fallback.
  const ct = (navResponse && navResponse.headers && navResponse.headers()['content-type']) || ''
  if (/pdf/i.test(ct)) {
    log(`URL is a PDF document (${finalUrl}) — downloading instead of extracting`)
    const dl = await downloadPdf(page, finalUrl, o.downloadDir, log)
    // Render the first pages to images from the downloaded file (pdftoppm,
    // then pdf-to-img) — no text extraction, immune to weird encodings /
    // scanned pages. Fallback: screenshots of the PDFium viewer.
    let shots = dl.ok ? await pdfToPageImages(dl.path, o.pdfPages, o.shotDir, log) : []
    if (shots.length === 0) {
      shots = await viewerPageImages(page, o.shotDir, o.pdfPages, log)
    }
    return pdfOutcome({ url, finalUrl, dl, shots })
  }
  const bodyInfo = await page
    .evaluate(() => {
      const b = document.body
      return { len: (b && b.innerText) || '', children: b ? b.children.length : -1 }
    })
    .catch(() => null)
  const viewerShape = bodyInfo !== null && bodyInfo.len.length < 10 && bodyInfo.children === 0
  // The URL-based fallback (no authoritative content-type) must not fire on a
  // 4xx/5xx response: an empty 401/403 at a .pdf URL is an auth failure, not
  // a PDF — that case keeps the wall → human-verify behavior.
  const navStatus = navResponse ? navResponse.status() : null
  if (
    (navStatus === null || navStatus < 400) &&
    !/text\/html/i.test(ct) &&
    isPdfUrl(url) &&
    (o.navigate === false || isPdfUrl(finalUrl)) &&
    viewerShape
  ) {
    log(`URL is a PDF document (${finalUrl}) — downloading instead of extracting`)
    const dl = await downloadPdf(page, finalUrl, o.downloadDir, log)
    // Render the first pages to images from the downloaded file (pdftoppm,
    // then pdf-to-img) — no text extraction, immune to weird encodings /
    // scanned pages. Fallback: screenshots of the PDFium viewer.
    let shots = dl.ok ? await pdfToPageImages(dl.path, o.pdfPages, o.shotDir, log) : []
    if (shots.length === 0) {
      shots = await viewerPageImages(page, o.shotDir, o.pdfPages, log)
    }
    return pdfOutcome({ url, finalUrl, dl, shots })
  }

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
  if (p.pdf) return false // a PDF is content, not a wall (its text is empty by design)
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
  const { maxChars = 8000, wantShot = false, downloadDir, pdfPages = 2 } = extra
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
    // Track the main-document MIME type per URL as the browser navigates. Once
    // the challenge passes and the target URL serves application/pdf, the page
    // IS a PDF even though its DOM stays empty (the PDFium viewer renders an
    // empty document) — the text-length probe below can never fire for it.
    const docMime = new Map()
    try {
      const cdp = await page.createCDPSession()
      await cdp.send('Network.enable')
      const docReqUrl = new Map()
      cdp.on('Network.requestWillBeSent', (e) => {
        if (e.type === 'Document') docReqUrl.set(e.requestId, e.url)
      })
      cdp.on('Network.responseReceived', (e) => {
        const rurl = docReqUrl.get(e.requestId)
        if (rurl) docMime.set(rurl, (e.response && e.response.mimeType) || '')
      })
    } catch {
      /* CDP unavailable — URL-extension detection still works as a fallback */
    }
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
    let solvedAsPdf = false
    while (Date.now() < deadline) {
      await sleep(2000)
      const st = await page
        .evaluate(() => {
          const b = document.body
          return { len: (b && b.innerText) || '', children: b ? b.children.length : -1 }
        })
        .catch(() => null)
      if (st === null) break // the human closed the window
      if (st.len.length > 300) {
        solved = true
        break
      }
      // The challenge was passed and the target is a PDF: detect it directly
      // and close the window at once instead of waiting out the full timeout
      // (the PDF viewer's empty document would otherwise never look "solved").
      const cur = page.url() || ''
      const mime = docMime.get(cur) || ''
      // Two signals, either is decisive on the same host:
      //  - the main document's MIME is application/pdf (CDP network map);
      //  - the current URL is a .pdf URL and the DOM has the empty PDFium
      //    viewer shape (same heuristic the headless path uses — the CDP
      //    map is not always populated, e.g. the navigation raced it).
      const isPdfNow =
        /^application\/pdf$/i.test(mime) ||
        (isPdfUrl(cur) && st.len.length < 10 && st.children === 0 && !/text\/html/i.test(mime))
      if (hostOf(cur) !== null && hostOf(cur) === hostOf(url) && isPdfNow) {
        solvedAsPdf = true
        break
      }
    }
    if (solvedAsPdf) {
      const finalUrl = page.url() || url
      log('challenge passed — the page is a PDF document; downloading and closing the window')
      const dl = await downloadPdf(page, finalUrl, downloadDir, log)
      // Render page images from the downloaded file before closing the
      // window (fallback: screenshots of the viewer).
      let shots = dl.ok ? await pdfToPageImages(dl.path, pdfPages, shotDir, log) : []
      if (shots.length === 0) {
        shots = await viewerPageImages(page, shotDir, pdfPages, log)
      }
      return pdfOutcome({ url, finalUrl, dl, shots, verifiedViaHuman: true })
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
      downloadDir,
      pdfPages,
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
 * @param {number}  [opts.pdfPages=2]        how many pages of a PDF document to capture as images (max 16)
 * @param {Function} [opts.log]
 * @returns {Promise<object>} outcome with status ok | error | blocked
 *   (`verifiedViaHuman: true` when a human passed the challenge). When the URL
 *   is a PDF document the outcome has `pdf: true` (never `blocked`), with
 *   `pdfShots` (page images in `<profileDir>/screenshots`) and `pdfPath`
 *   (file in `<profileDir>/downloads`) when those succeeded.
 */
export async function fetchPage(url, opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const profileDir = opts.profileDir || defaultProfileDir()
  const shotDir = path.join(profileDir, 'screenshots')
  const downloadDir = path.join(profileDir, 'downloads')
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
      downloadDir,
      pdfPages: opts.pdfPages ?? 2,
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
        downloadDir,
        pdfPages: opts.pdfPages ?? 2,
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
 * @param {number}  [opts.pdfPages=2]        how many pages of a PDF result page to capture as images (max 16)
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
    aiOverview: opts.aiOverview,
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
  const downloadDir = path.join(profileDir, 'downloads')
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
      aiOverview: search.aiOverview,
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
          downloadDir,
          pdfPages: opts.pdfPages ?? 2,
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
          downloadDir,
          pdfPages: opts.pdfPages ?? 2,
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
    aiOverview: search.aiOverview,
    pages,
  }
}
