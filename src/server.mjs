/**
 * dsh-google-chrome-search — MCP stdio server.
 *
 * Exposes five tools: `search` (Google web search by driving the local Chrome),
 * `fetch` (render a URL + extract readable content), `search_and_fetch`
 * (search + read the top N pages), `login` (sign in with a Google account in a
 * visible window, keeping the session in the persistent profile), and
 * `account` (check whether the profile holds a signed-in Google account).
 * Register it with DSH's
 * `@deepseek-ai/dsh-mcp-client` (transport: stdio) and the agent gets the native
 * `mcp__chinchilla-websearch__*` tools.
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
import { googleLogin, checkGoogleAccount } from './login.mjs'

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

/** Render Google's AI Overview (AI-generated answer + cited references), if present. */
function formatAiOverview(ai, indent = '') {
  if (!ai || !ai.present) return null
  const lines = []
  lines.push(`${indent}── AI Overview (Google's AI-generated answer) ──────────────────`)
  if (ai.text) lines.push(ai.text.split('\n').map((l) => `${indent}${l}`).join('\n'))
  if (ai.references && ai.references.length > 0) {
    lines.push('')
    lines.push(`${indent}References cited by Google:`)
    ai.references.forEach((r, i) => {
      lines.push(`${indent} ${i + 1}. ${r.title || r.url}`)
      lines.push(`${indent}    ${r.url}`)
    })
  }
  lines.push(`${indent}──────────────────────────────────────────────────────────────`)
  return lines.join('\n')
}

function formatResults(outcome) {
  const lines = []
  lines.push(`Google search results for: ${outcome.query}`)
  if (outcome.url) lines.push(`(source: ${outcome.url})`)
  lines.push('')
  const ai = formatAiOverview(outcome.aiOverview)
  if (ai) {
    lines.push(ai)
    lines.push('')
  }
  if (!outcome.results || outcome.results.length === 0) {
    lines.push('(no organic results returned)')
    return lines.join('\n')
  }
  lines.push('Organic results:')
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
      'human to complete the verification, then call search again (the verified session is kept). ' +
      'If the profile is signed in with a Google account (see the login/account tools), searches ' +
      'run as that account; that session is scoped to this plugin\'s web search only — never use ' +
      'it for other Google services or personal data.',
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
      aiOverview: z
        .boolean()
        .default(true)
        .describe(
          'Also capture Google\'s AI Overview (the AI-generated answer + the references it cites). ' +
            'Set false to skip it. When Google has no AI Overview for the query, this has no effect.',
        ),
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
          aiOverview: args.aiOverview,
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
  if (p.pdf) {
    lines.push('(PDF document — its contents are not text-extracted)')
    lines.push(`PDF URL: ${p.finalUrl || p.url}`)
    for (const [i, s] of (p.pdfShots || []).entries()) {
      lines.push(`Page ${i + 1} image (read it as an image): ${s}`)
    }
    if (p.pdfPath) {
      lines.push(`Full file (for pages beyond the captured ones / exact text): ${p.pdfPath}${p.pdfSize ? ` (${(p.pdfSize / 1024).toFixed(1)} KB)` : ''}`)
    }
    if (p.verifiedViaHuman) lines.push('(the page was behind a verification challenge — passed via the visible window)')
    if (p.message) lines.push(p.message)
    return lines.join('\n')
  }
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
      'via search or anywhere else. If a site serves a human-verification challenge (anti-bot ' +
      'slider), a visible Chrome window is opened for the human to solve it (autoVerify). ' +
      'If the URL is a PDF document, it is detected (NOT treated as a bot-wall): the ' +
      'first N pages are captured as images (default 2, set with pdfPages — read them ' +
      'as images, PDFs are not text-extracted) and the full file is downloaded to the ' +
      'profile\'s downloads folder; the image blocks are attached and both paths are ' +
      'returned. Use the file (e.g. with a PDF tool) for pages beyond the captured ' +
      'ones or exact text. If the human passes a challenge and the page turns out to ' +
      'be a PDF, the window closes immediately. ' +
      'The profile may hold a signed-in Google account scoped to search: do NOT use this tool ' +
      'to open or extract the user\'s private pages (Gmail, Drive, personal pages) or any ' +
      'personal data — public web content in service of a search task only.',
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
      autoVerify: z
        .boolean()
        .default(true)
        .describe(
          'If the site serves a human-verification challenge, open a visible Chrome window and wait for the human to solve it (default true).',
        ),
      verifyTimeoutMs: z
        .number()
        .int()
        .min(5000)
        .max(600000)
        .default(150000)
        .describe('How long (ms) to wait for the human to pass a page challenge (default 150000).'),
      pdfPages: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(2)
        .describe(
          'When the URL is a PDF, how many pages to capture as images (default 2). ' +
            'Only relevant for PDF documents.',
        ),
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
          autoVerify: args.autoVerify,
          verifyTimeoutMs: args.verifyTimeoutMs,
          pdfPages: args.pdfPages,
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
        for (const s of outcome.pdfShots || []) {
          const pageImg = readScreenshotAsImageBlock(s)
          if (pageImg) content.push(pageImg)
        }
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
  const ai = formatAiOverview(outcome.aiOverview)
  if (ai) {
    lines.push('')
    lines.push(ai)
  }
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
      'top pages. Slower than plain search (~1-3 s per page). Result pages that are PDF ' +
      'documents are detected as such: their first pages are captured as images ' +
      '(pdfPages, default 2) and the full file is downloaded, and the paths are ' +
      'reported instead of text. If the profile is signed in with a Google account, the ' +
      'session is scoped to ' +
      'this plugin\'s web search only — never use it for other Google services or personal ' +
      'data.',
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
        .describe('How long (ms) to wait for a human CAPTCHA/challenge (default 150000).'),
      autoVerify: z
        .boolean()
        .default(true)
        .describe(
          'If Google or a result page serves a human-verification challenge, open a visible ' +
          'Chrome window and wait for the human to solve it (default true).',
        ),
      pdfPages: z
        .number()
        .int()
        .min(1)
        .max(16)
        .default(2)
        .describe(
          'When a result page is a PDF, how many pages to capture as images (default 2). ' +
            'Only relevant for PDF result pages.',
        ),
      aiOverview: z
        .boolean()
        .default(true)
        .describe(
          'Also capture Google\'s AI Overview (the AI-generated answer + the references it cites) ' +
            'from the search. Set false to skip it.',
        ),
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
          autoVerify: args.autoVerify,
          pdfPages: args.pdfPages,
          aiOverview: args.aiOverview,
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

// ---------------------------------------------------------------------------
// login: sign in with a Google account in a visible window
// ---------------------------------------------------------------------------

server.registerTool(
  'login',
  {
    title: 'Sign in with a Google account (visible window)',
    description:
      'Open a VISIBLE Chrome window pointed at Google\'s account page so the human can sign in ' +
      'with their own Google account; the session is then stored in the plugin\'s persistent ' +
      'profile, so later searches run as that real, signed-in account (far more trusted than ' +
      'anonymous traffic — CAPTCHAs become much rarer and the session lasts a long time). The ' +
      'agent NEVER sees the credentials — the human types them directly into the real Chrome ' +
      'window; never ask for, handle, or transmit them. The resulting session is scoped to ' +
      'this plugin\'s web search only — never use it for other Google services (Gmail, Drive, ' +
      '…) or personal data. Call this when the user wants to "log into Google" / "use my ' +
      'account" / keep a long-lived trusted session. Then tell the human to complete the ' +
      'sign-in in the opened window and let you know when it\'s done (or the window is closed ' +
      '/ it times out).',
    inputSchema: {
      waitMs: z
        .number()
        .int()
        .min(10000)
        .max(1800000)
        .default(300000)
        .describe('How long (ms) to wait for the human to complete the sign-in (default 300000 = 5 min).'),
      startUrl: z
        .string()
        .url()
        .default('https://accounts.google.com/SignOutOptions')
        .describe(
          'The page to open in the visible window (default: Google\'s account page, which shows the sign-in form when signed out).',
        ),
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
        outcome = await googleLogin({
          waitMs: args.waitMs,
          startUrl: args.startUrl,
          signal,
          log,
        })
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Google login failed: ${err && err.message ? err.message : String(err)}` }],
        }
      }
      const ok = outcome.status === 'logged_in' || outcome.status === 'already_signed_in'
      const content = [
        {
          type: 'text',
          text:
            `${ok ? 'Google sign-in complete.' : 'Google sign-in did not complete.\n'}` +
            `${outcome.message || ''}\n` +
            `Status: ${outcome.status}\n` +
            (outcome.account ? `Account: ${outcome.account}\n` : '') +
            `Profile: ${outcome.profileDir}\n`,
        },
      ]
      return ok ? { content } : { isError: true, content }
    }),
)

// ---------------------------------------------------------------------------
// account: check whether the profile holds a signed-in Google account
// ---------------------------------------------------------------------------

server.registerTool(
  'account',
  {
    title: 'Check Google account session in the profile',
    description:
      'Check (headless, no window) whether the plugin\'s persistent profile currently holds a ' +
      'signed-in Google account. Returns the account label (usually the email) when present. ' +
      'Use this to see whether the "login" tool has already been run and whether searches ' +
      'currently run with a Google account. The account label is identity information only — ' +
      'the session behind it is scoped to this plugin\'s web search, never to other Google ' +
      'services or personal data.',
    inputSchema: {},
  },
  async () =>
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
        outcome = await checkGoogleAccount({ log })
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Account check failed: ${err && err.message ? err.message : String(err)}` }],
        }
      }
      const ok = outcome.status === 'logged_in'
      const content = [
        {
          type: 'text',
          text:
            `${outcome.status === 'logged_in' ? 'Profile is signed in with a Google account.' : 'Profile has no Google account session.\n'}` +
            `${outcome.message || ''}\n` +
            (outcome.account ? `Account: ${outcome.account}\n` : '') +
            `Profile: ${outcome.profileDir}\n`,
        },
      ]
      return ok ? { content } : { isError: true, content }
    }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[google-chrome-search] MCP server ready (stdio).')
