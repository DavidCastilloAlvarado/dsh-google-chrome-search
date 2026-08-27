/**
 * dsh-google-chrome-search — MCP stdio server.
 *
 * Exposes a `search` tool that runs a Google web search by driving the local Chrome.
 * Register it with DSH's `@deepseek-ai/dsh-mcp-client` (transport: stdio) and the
 * agent gets a native `mcp__google__search` tool.
 *
 * NOTE: stdout is the JSON-RPC channel — all human/progress logging MUST go to
 * stderr. The `googleSearch` log callback is wired to console.error below.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { googleSearch } from './search.mjs'
import { fetchPage, searchAndFetch } from './fetch.mjs'

/**
 * Serialize tool calls: Chrome allows only one process per user-data-dir, so
 * concurrent calls against the same profile would fail with a profile lock.
 */
let chain = Promise.resolve()
function withLock(fn) {
  const p = chain.then(() => fn())
  chain = p.catch(() => {})
  return p
}

function readScreenshotAsImageBlock(path) {
  try {
    if (path && fs.existsSync(path)) {
      const b64 = fs.readFileSync(path).toString('base64')
      return { type: 'image', data: b64, mimeType: 'image/png' }
    }
  } catch {
    /* ignore */
  }
  return null
}

function formatResults(outcome) {
  const lines = []
  lines.push(`Google search results for: ${outcome.query}`)
  if (outcome.url) lines.push(`(source: ${outcome.url})`)
  lines.push('')
  if (!outcome.results || outcome.results.length === 0) {
    lines.push('(no organic results returned)')
    return lines.join('\n')
  }
  outcome.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.link}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
  })
  return lines.join('\n')
}

const pkg = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
)

const server = new McpServer({
  name: 'google',
  version: pkg.version,
})

server.registerTool(
  'search',
  {
    title: 'Google Search (local Chrome)',
    description:
      'Search Google using the local Chrome browser over CDP. Runs headless first; if Google ' +
      'serves a human-verification (CAPTCHA) page, it opens a VISIBLE Chrome window for the human ' +
      'to solve, then continues. Use this to search Google directly. If the result is ' +
      "'verification_required', a Chrome window was opened (and a screenshot returned) — tell the " +
      'human to complete the verification, then call search again (the verified session is kept).',
    inputSchema: {
      query: z.string().min(1).describe('The search query.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(8)
        .describe('Maximum number of organic results to return (default 8).'),
      gl: z.string().optional().describe('Google region code, e.g. "us". Defaults to us.'),
      hl: z.string().optional().describe('Google UI language, e.g. "en". Defaults to en.'),
      verifyTimeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(600000)
        .default(150000)
        .describe(
          'How long (ms) to wait for the human to complete the CAPTCHA in the opened window (default 150000).',
        ),
      autoVerify: z
        .boolean()
        .default(true)
        .describe('If false, never open a visible window — just report that verification is required.'),
    },
  },
  async (args, extra) =>
    withLock(async () => {
      const signal = extra && extra.signal
      const log = (msg) => {
        try {
          console.error(`[google-chrome-search] ${msg}`)
        } catch {
          /* ignore */
        }
      }
      let outcome
      try {
        outcome = await googleSearch(args.query, {
          maxResults: args.maxResults,
          gl: args.gl,
          hl: args.hl,
          verifyTimeoutMs: args.verifyTimeoutMs,
          autoVerify: args.autoVerify,
          signal,
        })
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Google search failed: ${err && err.message ? err.message : String(err)}` }],
        }
      }

      if (outcome.status === 'ok') {
        return {
          content: [{ type: 'text', text: formatResults(outcome) }],
        }
      }

      // verification_required / no_results — surface a screenshot so the agent
      // can relay what happened.
      const content = [
        {
          type: 'text',
          text:
            `${outcome.status === 'verification_required' ? 'Google requires human verification for this search.\n' : 'Google did not return results for this search.\n'}` +
            `${outcome.message || ''}\n` +
            `Query: ${outcome.query}\n` +
            `URL: ${outcome.url}\n\n` +
            (outcome.status === 'verification_required'
              ? 'Please ask the human to complete the verification in the opened Chrome window, then call this search again.'
              : 'If a screenshot is attached, inspect it; if it shows a verification page, ask the human to verify, then call this search again.'),
        },
      ]
      const img = readScreenshotAsImageBlock(outcome.screenshot)
      if (img) content.push(img)
      return { isError: true, content }
    }),
)

// ---------------------------------------------------------------------------
// fetch: render one URL and extract its readable content
// ---------------------------------------------------------------------------

function formatPage(p) {
  const lines = []
  lines.push(`# ${p.title || '(untitled)'}`)
  if (p.byline) lines.push(`by ${p.byline}`)
  if (p.siteName) lines.push(`site: ${p.siteName}`)
  lines.push(`URL: ${p.finalUrl || p.url}`)
  if (!p.readable) lines.push('(full-page text — no distinct article found)')
  lines.push('')
  lines.push(p.text || '(no text extracted)')
  if (p.truncated) lines.push('[truncated]')
  return lines.join('\n')
}

server.registerTool(
  'fetch',
  {
    title: 'Fetch & extract page content (local Chrome)',
    description:
      'Render a URL with the local Chrome browser and extract its readable main content ' +
      '(Mozilla Readability). Returns the article text (capped), title, byline, and the final ' +
      'URL after redirects. Use this to read any webpage in depth: docs, articles, pages found ' +
      'via search or anywhere else. Sites with strong anti-bot protection may report "blocked".',
    inputSchema: {
      url: z.string().url().describe('The page URL to fetch (http/https).'),
      maxChars: z
        .number()
        .int()
        .min(200)
        .max(50000)
        .default(8000)
        .describe('Maximum characters of extracted text to return (default 8000).'),
      includeHtml: z
        .boolean()
        .default(false)
        .describe('Also return the extracted HTML (default false).'),
      screenshot: z
        .boolean()
        .default(false)
        .describe('Also capture and attach a screenshot of the rendered page (default false).'),
    },
  },
  async (args) =>
    withLock(async () => {
      const log = (msg) => {
        try {
          console.error(`[google-chrome-search] ${msg}`)
        } catch {
          /* ignore */
        }
      }
      let outcome
      try {
        outcome = await fetchPage(args.url, {
          maxChars: args.maxChars,
          includeHtml: args.includeHtml,
          screenshot: args.screenshot,
          log,
        })
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Fetch failed: ${err && err.message ? err.message : String(err)}` }],
        }
      }

      if (outcome.status === 'ok') {
        const text =
          formatPage(outcome) + (outcome.html ? `\n\n--- HTML (capped) ---\n${outcome.html}` : '')
        const content = [{ type: 'text', text }]
        const img = readScreenshotAsImageBlock(outcome.screenshot)
        if (img) content.push(img)
        return { content }
      }

      const content = [
        {
          type: 'text',
          text:
            `${outcome.status === 'blocked' ? 'The site blocked the headless browser (anti-bot wall).\n' : 'Fetch failed.\n'}` +
            `${outcome.message || ''}\n` +
            `URL: ${outcome.url}\n` +
            `Final URL: ${outcome.finalUrl || 'n/a'}\n` +
            (outcome.text ? `\nPage text (partial):\n${outcome.text}` : ''),
        },
      ]
      const img = readScreenshotAsImageBlock(outcome.screenshot)
      if (img) content.push(img)
      return { isError: true, content }
    }),
)

// ---------------------------------------------------------------------------
// search_and_fetch: search Google, then render + extract the top N pages
// ---------------------------------------------------------------------------

function formatSearchAndFetch(outcome) {
  const lines = []
  lines.push(`Google search: ${outcome.query}`)
  lines.push(`Fetched ${outcome.pages.length} of ${outcome.resultCount} results (source: ${outcome.searchUrl})`)
  if (outcome.verifiedViaHuman) lines.push('(search completed via human verification)')
  lines.push('')
  outcome.pages.forEach((p, i) => {
    lines.push(`=== Result ${i + 1}: ${p.title || p.url} ===`)
    if (p.status === 'ok') {
      lines.push(formatPage(p))
    } else {
      lines.push(`[fetch ${p.status}: ${p.message || 'failed'}]`)
    }
    lines.push('')
  })
  return lines.join('\n')
}

server.registerTool(
  'search_and_fetch',
  {
    title: 'Google search + read top pages (local Chrome)',
    description:
      'Run a Google web search, then render the top N result pages with the local Chrome and ' +
      'extract their readable main content. Returns each page as article text (capped per page). ' +
      'Use this when the search snippets are not enough and you need the actual content of the ' +
      'top pages. Slower than plain search (~1-3 s per page).',
    inputSchema: {
      query: z.string().min(1).describe('The search query.'),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe('Number of search results to retrieve (default 5).'),
      fetchTop: z
        .number()
        .int()
        .min(1)
        .max(5)
        .default(3)
        .describe('How many of the top results to render and extract (default 3, max 5).'),
      maxChars: z
        .number()
        .int()
        .min(200)
        .max(50000)
        .default(8000)
        .describe('Maximum characters of extracted text per page (default 8000).'),
      gl: z.string().optional().describe('Google region code, e.g. "us". Defaults to us.'),
      hl: z.string().optional().describe('Google UI language, e.g. "en". Defaults to en.'),
      verifyTimeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(600000)
        .default(150000)
        .describe('How long (ms) to wait for a human CAPTCHA in the search step (default 150000).'),
    },
  },
  async (args) =>
    withLock(async () => {
      const log = (msg) => {
        try {
          console.error(`[google-chrome-search] ${msg}`)
        } catch {
          /* ignore */
        }
      }
      let outcome
      try {
        outcome = await searchAndFetch(args.query, {
          maxResults: args.maxResults,
          fetchTop: args.fetchTop,
          maxChars: args.maxChars,
          gl: args.gl,
          hl: args.hl,
          verifyTimeoutMs: args.verifyTimeoutMs,
          log,
        })
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Search+fetch failed: ${err && err.message ? err.message : String(err)}` }],
        }
      }

      if (outcome.status === 'ok') {
        return { content: [{ type: 'text', text: formatSearchAndFetch(outcome) }] }
      }

      // The search step itself did not return results (verification, etc.).
      const content = [
        {
          type: 'text',
          text:
            `${outcome.status === 'verification_required' ? 'Google requires human verification for this search.\n' : 'Google did not return results for this search.\n'}` +
            `${outcome.message || ''}\n` +
            `Query: ${outcome.query}\n` +
            `URL: ${outcome.url}\n\n` +
            (outcome.status === 'verification_required'
              ? 'Please ask the human to complete the verification in the opened Chrome window, then call this tool again.'
              : 'If a screenshot is attached, inspect it and retry.'),
        },
      ]
      const img = readScreenshotAsImageBlock(outcome.screenshot)
      if (img) content.push(img)
      return { isError: true, content }
    }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[google-chrome-search] MCP server ready (stdio).')
