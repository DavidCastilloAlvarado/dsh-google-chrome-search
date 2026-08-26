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
  async (args, extra) => {
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
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[google-chrome-search] MCP server ready (stdio).')
