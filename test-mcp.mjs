/**
 * Standalone MCP smoke test.
 *
 * 1. Spawns the MCP server and verifies the `search` tool is listed.
 * 2. If a Chrome/Chromium binary is available, also calls `search` with
 *    autoVerify:false (so no window opens) and prints the result.
 *    If no browser is found (e.g. in CI), the search call is skipped.
 *
 * Exit code is 0 when the server works, regardless of whether Google
 * returns results or serves a CAPTCHA.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  for (const name of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      return execFileSync('which', [name], { stdio: 'ignore' }).toString().trim() || null
    } catch {
      /* not on PATH */
    }
  }
  return null
}

const chrome = findChrome()
const env = { ...process.env }
if (chrome) env.CHROME_PATH = chrome

const here = fileURLToPath(import.meta.url)
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(path.dirname(here), 'src', 'server.mjs')],
  cwd: path.dirname(here),
  env,
})

const client = new Client({ name: 'dsh-test', version: '0.0.0' })
await client.connect(transport)

const tools = await client.listTools()
const names = tools.tools.map((t) => t.name)
console.log('TOOLS:', JSON.stringify(names))
for (const expected of ['search', 'fetch', 'search_and_fetch', 'login', 'account']) {
  if (!names.includes(expected)) {
    console.error(`FAIL: \`${expected}\` tool not listed by the MCP server`)
    await client.close()
    process.exit(1)
  }
}
console.log('OK: MCP server lists the search, fetch, search_and_fetch, login, and account tools')

if (!chrome) {
  console.log('SKIP: no Chrome/Chromium found — skipping the live search call (CI mode)')
  await client.close()
  process.exit(0)
}

console.log(`Calling search with Chrome at ${chrome} (autoVerify: false)…`)
const res = await client.callTool({
  name: 'search',
  arguments: { query: 'nodejs streams', maxResults: 3, autoVerify: false },
})
console.log('IS_ERROR:', res.isError)
let textOut = ''
for (const c of res.content) {
  if (c.type === 'text') {
    textOut += c.text
    console.log('TEXT:\n' + c.text)
  }
  if (c.type === 'image') console.log('IMAGE: (screenshot, ' + c.data.length + ' b64 chars)')
}
// "Organic results" is always present in a successful search; "AI Overview" is
// intermittent (Google only shows it for some queries / A-B variants), so it is
// reported but not required.
if (!textOut.includes('Organic results')) {
  console.error('FAIL: search output is missing the "Organic results" section')
  await client.close()
  process.exit(1)
}
console.log('OK: search output contains the "Organic results" section')
console.log(textOut.includes('AI Overview') ? 'INFO: "AI Overview" section was present' : 'INFO: no "AI Overview" for this query (expected for some queries)')
await client.close()
process.exit(0)
