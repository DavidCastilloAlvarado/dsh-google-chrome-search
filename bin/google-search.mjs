#!/usr/bin/env node
/**
 * dsh-google-search — CLI.
 *
 * Usage:
 *   dsh-google-search "<query>" [options]
 *   dsh-google-search fetch "<url>" [options]
 *   dsh-google-search install-browser [--force]
 *   dsh-google-search mcp
 *   node bin/google-search.mjs "<query>" [options]
 *
 * install-browser options:
 *   --force              re-download even if a bundled browser is already installed
 *   --profile <dir>      profile dir to install into (default: $GSEARCH_PROFILE or ~/.dsh-chrome-google)
 *
 * mcp:
 *   Run the MCP stdio server (search / fetch / search_and_fetch tools).
 *   This is the entry point for DSH/MCP registration via npx.
 *
 * Search options:
 *   --max <n>              max organic results (default 8)
 *   --gl <code>            region (default us)
 *   --hl <code>            language (default en)
 *   --verify-timeout <ms>  how long to wait for the human to solve a CAPTCHA (default 150000)
 *   --no-verify            never open a visible window; just report that verification is needed
 *   --headless/--headed    force the first attempt to be headless (default) or visible
 *   --fetch-top <n>        after the search, render and extract the top N result pages (0 = off, max 5)
 *   --fetch-max-chars <n>  max characters of extracted text per page (default 8000)
 *   --json                 print the raw JSON outcome
 *   --chrome <path>        Chrome executable path
 *   --profile <dir>        persistent Chrome profile dir
 *
 * Fetch options:
 *   --max-chars <n>        max characters of extracted text (default 8000)
 *   --html                 also print the extracted HTML
 *   --screenshot           also save a screenshot of the rendered page
 *   --timeout <ms>         navigation timeout (default 20000)
 *   --no-verify            if the site serves a human-verification challenge, do NOT open
 *                          a visible window — just report "blocked"
 *   --verify-timeout <ms>  how long to wait for the human to pass a page challenge (default 150000)
 *   --json                 print the raw JSON outcome
 *   --chrome <path>        Chrome executable path
 *   --profile <dir>        persistent Chrome profile dir
 */

import { googleSearch, defaultProfileDir } from '../src/search.mjs'
import { fetchPage, searchAndFetch } from '../src/fetch.mjs'
import { installBrowser } from '../src/browser.mjs'

function parseArgs(argv) {
  const opts = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--max':
      case '-n':
        opts.maxResults = parseInt(next(), 10)
        break
      case '--gl':
        opts.gl = next()
        break
      case '--hl':
        opts.hl = next()
        break
      case '--verify-timeout':
        opts.verifyTimeoutMs = parseInt(next(), 10)
        break
      case '--no-verify':
        opts.autoVerify = false
        break
      case '--headless':
        opts.headless = true
        break
      case '--headed':
        opts.headless = false
        break
      case '--fetch-top':
        opts.fetchTop = parseInt(next(), 10)
        break
      case '--fetch-max-chars':
        opts.fetchMaxChars = parseInt(next(), 10)
        break
      case '--max-chars':
        opts.maxChars = parseInt(next(), 10)
        break
      case '--html':
        opts.includeHtml = true
        break
      case '--screenshot':
        opts.screenshot = true
        break
      case '--timeout':
        opts.timeoutMs = parseInt(next(), 10)
        break
      case '--json':
        opts.json = true
        break
      case '--force':
        opts.force = true
        break
      case '--chrome':
        opts.chromePath = next()
        break
      case '--profile':
        opts.profileDir = next()
        break
      case '-h':
      case '--help':
        opts.help = true
        break
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`Unknown option: ${a}\n`)
          process.exit(64)
        }
        positional.push(a)
    }
  }
  opts.query = positional.join(' ').trim()
  return opts
}

function printReadable(o) {
  if (o.status === 'ok') {
    console.log(`Google search results for: ${o.query}`)
    if (o.url) console.log(`(source: ${o.url})`)
    console.log('')
    if (!o.results || o.results.length === 0) {
      console.log('(no organic results returned)')
    } else {
      o.results.forEach((r, i) => {
        console.log(`${i + 1}. ${r.title}`)
        console.log(`   ${r.link}`)
        if (r.snippet) console.log(`   ${r.snippet}`)
      })
    }
    if (o.verifiedViaHuman) console.log('\n(completed via human verification)')
  } else {
    console.log(`STATUS: ${o.status}`)
    console.log(o.message || '')
    if (o.screenshot) console.log(`Screenshot: ${o.screenshot}`)
  }
}

function printFetch(p) {
  if (p.status !== 'ok') {
    console.log(`FETCH ${p.status.toUpperCase()}: ${p.url}`)
    console.log(p.message || '')
    if (p.finalUrl) console.log(`Final URL: ${p.finalUrl}`)
    if (p.screenshot) console.log(`Screenshot: ${p.screenshot}`)
    return
  }
  console.log(`URL: ${p.finalUrl || p.url}`)
  console.log(`Title: ${p.title || '(untitled)'}`)
  if (p.byline) console.log(`By: ${p.byline}`)
  if (p.siteName) console.log(`Site: ${p.siteName}`)
  console.log(`Mode: ${p.readable ? 'readable article' : 'full page text'}`)
  if (p.verifiedViaHuman) console.log('Verified via human')
  console.log('')
  console.log(p.text || '(no text extracted)')
  if (p.truncated) console.log('\n[truncated]')
  if (p.html) {
    console.log('\n--- HTML (capped) ---')
    console.log(p.html)
  }
  if (p.screenshot) console.log(`\nScreenshot: ${p.screenshot}`)
}

function printSearchAndFetch(o) {
  console.log(`Google search results for: ${o.query}`)
  if (o.searchUrl) console.log(`(source: ${o.searchUrl})`)
  if (o.verifiedViaHuman) console.log('(completed via human verification)')
  if (!o.pages) return
  console.log(`\nFound ${o.resultCount} result(s); fetched ${o.pages.length} page(s)\n`)
  o.pages.forEach((p, i) => {
    console.log(`--- Page ${i + 1}: ${p.title || p.url} ---`)
    printFetch(p)
    console.log('')
  })
}

async function main() {
  const argv = process.argv.slice(2)
  const isFetch = argv[0] === 'fetch'
  const isInstallBrowser = argv[0] === 'install-browser'
  const isMcp = argv[0] === 'mcp'
  const sub = isFetch || isInstallBrowser || isMcp
  const opts = parseArgs(sub ? argv.slice(1) : argv)

  const text =
    'dsh-google-search — Google web search + page content extraction via the local Chrome\n' +
    '(with human-verification fallback)\n' +
    'Usage:\n' +
    '  dsh-google-search "<query>" [options]\n' +
    '  dsh-google-search fetch "<url>" [options]\n' +
    '  dsh-google-search install-browser [--force]   download Chrome for Testing (self-contained setup)\n' +
    '  dsh-google-search mcp                         run the MCP stdio server\n' +
    'See header comment for options.\n'
  if (opts.help || (!opts.query && !sub)) {
    if (opts.help) console.log(text)
    else process.stderr.write(text)
    process.exit(opts.help ? 0 : 64)
  }

  const log = (msg) => {
    try {
      process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`)
    } catch {
      /* ignore */
    }
  }

  if (isMcp) {
    // The MCP stdio server connects itself on import and stays alive.
    await import('../src/server.mjs')
    return
  }

  if (isInstallBrowser) {
    try {
      const res = await installBrowser({
        profileDir: opts.profileDir || defaultProfileDir(),
        force: !!opts.force,
        log,
      })
      if (res.installed) {
        console.log(`Installed Chrome for Testing ${res.buildId} (${res.platform}):`)
        console.log(`  ${res.executablePath}`)
        console.log('\nIt will be used automatically when no other browser is configured.')
        console.log('To remove it, delete the "browser" folder and browser-info.json inside the profile dir.')
      } else {
        console.log(`Bundled browser already installed:`)
        console.log(`  ${res.executablePath}`)
      }
      process.exit(0)
    } catch (err) {
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`)
      process.exit(1)
    }
  }

  let outcome
  try {
    if (isFetch) {
      outcome = await fetchPage(opts.query, {
        maxChars: opts.maxChars,
        includeHtml: opts.includeHtml,
        screenshot: opts.screenshot,
        timeoutMs: opts.timeoutMs,
        autoVerify: opts.autoVerify,
        verifyTimeoutMs: opts.verifyTimeoutMs,
        chromePath: opts.chromePath,
        profileDir: opts.profileDir,
        log,
      })
    } else if (opts.fetchTop > 0) {
      outcome = await searchAndFetch(opts.query, {
        maxResults: opts.maxResults,
        fetchTop: opts.fetchTop,
        maxChars: opts.fetchMaxChars,
        gl: opts.gl,
        hl: opts.hl,
        verifyTimeoutMs: opts.verifyTimeoutMs,
        autoVerify: opts.autoVerify,
        chromePath: opts.chromePath,
        profileDir: opts.profileDir,
        log,
      })
    } else {
      outcome = await googleSearch(opts.query, {
        maxResults: opts.maxResults,
        gl: opts.gl,
        hl: opts.hl,
        verifyTimeoutMs: opts.verifyTimeoutMs,
        autoVerify: opts.autoVerify,
        headless: opts.headless,
        chromePath: opts.chromePath,
        profileDir: opts.profileDir,
        log,
      })
    }
  } catch (err) {
    process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`)
    process.exit(1)
  }

  if (opts.json) {
    console.log(JSON.stringify(outcome, null, 2))
  } else if (isFetch) {
    printFetch(outcome)
  } else if (opts.fetchTop > 0) {
    printSearchAndFetch(outcome)
  } else {
    printReadable(outcome)
  }

  const exitCode =
    outcome.status === 'ok' ? 0 : outcome.status === 'verification_required' ? 2 : 3
  process.exit(exitCode)
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e && e.stack ? e.stack : String(e)}\n`)
  process.exit(1)
})
