#!/usr/bin/env node
/**
 * dsh-google-search — CLI.
 *
 * Usage:
 *   dsh-google-search "your query" [options]
 *   node bin/google-search.mjs "your query" [options]
 *
 * Options:
 *   --max <n>           max organic results (default 8)
 *   --gl <code>         region (default us)
 *   --hl <code>         language (default en)
 *   --verify-timeout <ms>  how long to wait for the human to solve a CAPTCHA (default 150000)
 *   --no-verify         never open a visible window; just report that verification is needed
 *   --headless/--headed  force the first attempt to be headless (default) or visible
 *   --json              print the raw JSON outcome
 *   --chrome <path>     Chrome executable path
 *   --profile <dir>     persistent Chrome profile dir
 */

import { googleSearch, defaultProfileDir } from '../src/search.mjs'

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
      case '--json':
        opts.json = true
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

async function main() {
  const argv = process.argv.slice(2)
  const opts = parseArgs(argv)
  if (opts.help || !opts.query) {
    const text =
      'dsh-google-search — Google web search via the local Chrome (with human-verification fallback)\n' +
      'Usage: dsh-google-search "<query>" [options]\n' +
      'See header comment for options.\n'
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

  let outcome
  try {
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
  } catch (err) {
    process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`)
    process.exit(1)
  }

  if (opts.json) {
    console.log(JSON.stringify(outcome, null, 2))
  } else {
    printReadable(outcome)
  }

  const exitCode = outcome.status === 'ok' ? 0 : outcome.status === 'verification_required' ? 2 : 3
  process.exit(exitCode)
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e && e.stack ? e.stack : String(e)}\n`)
  process.exit(1)
})
