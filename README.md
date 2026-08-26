# dsh-google-chrome-search

[![CI](https://github.com/OWNER/dsh-google-chrome-search/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dsh-google-chrome-search/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node: >=18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org)

A **DeepSeek Harness (DSH) plugin** that lets an **AI agent** run a real **Google web search**
by driving the **local Chrome** browser over CDP (Chrome DevTools Protocol). **No search API
key needed** — it works with the Chrome already installed on the machine.

Google frequently serves a human-verification page (CAPTCHA / "unusual traffic") for automated
and datacenter traffic. When that happens, this plugin **opens a visible Chrome window** pointed
at the verification page, **waits for the human to solve it**, and then extracts the results
from the now-trusted session. That is the "ask the human" step — by design, the agent never
tries to solve a CAPTCHA itself.

![Google's verification page, as shown to the human](docs/captcha-verification.png)

## What you get

| Piece | Path | Purpose |
|---|---|---|
| Core engine | `src/search.mjs` | Chrome/CDP Google search + CAPTCHA verification + result extraction |
| MCP server | `src/server.mjs` | Exposes a `search` tool over stdio → native `mcp__google__search` in DSH |
| CLI | `bin/google-search.mjs` | `dsh-google-search "<query>"` for direct use / from the skill |
| Skill | `skill/SKILL.md` | Teaches the agent how to use it + the human-verification workflow |

## Requirements

- **Node.js ≥ 18** (tested on Node 22)
- **A local Chrome/Chromium binary** (e.g. `google-chrome`, `chromium`). Auto-detected from
  common paths; override with `CHROME_PATH` or `--chrome`.
- For the visible-verification step, a desktop session with a display (so the Chrome
  window can be shown to the human). Headless/SSH can still detect the CAPTCHA and report
  it (with a screenshot).

## Install

```sh
git clone https://github.com/OWNER/dsh-google-chrome-search.git
cd dsh-google-chrome-search
npm install
```

Dependencies: `puppeteer-core` (drives *your* Chrome — it does **not** download a browser),
`@modelcontextprotocol/sdk` (for the MCP server), and `zod` (schema validation).

Optionally link the CLI globally so it is on `PATH`:

```sh
npm link        # gives you: dsh-google-search "<query>"
```

## Use the CLI

```sh
node bin/google-search.mjs "nodejs streams" --max 8
# or, after npm install / npm link:
npm run search -- "nodejs streams" --json
```

Exit codes: `0` = results, `2` = verification required (CAPTCHA), `3` = no results,
`1` = error, `64` = usage.

## Use it as a native DSH tool (MCP)

Register the MCP server with DSH's `@deepseek-ai/dsh-mcp-client` in your profile config
(example — adjust the `command` and `args` paths to your environment):

```yaml
- insert:
    - id: mcp-google
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: google
        transport: stdio
        command: /path/to/node
        args: [ /path/to/dsh-google-chrome-search/src/server.mjs ]
        env:
          CHROME_PATH: /usr/bin/google-chrome   # optional — auto-detected if unset
        toolCallTimeoutMs: 300000
```

After a DSH restart, the agent gets a native `mcp__google__search` tool.

## Use it as a DSH skill

`skill/SKILL.md` teaches the agent how to run the search and how to handle the CAPTCHA
hand-off to the human. To install it, copy it into your DSH skills directory, e.g.:

```sh
mkdir -p ~/.dsh/skills/google-chrome-search
cp skill/SKILL.md ~/.dsh/skills/google-chrome-search/
```

**Before sharing/using it on another machine, edit the `<INSTALL_DIR>` placeholder inside
`SKILL.md` to point at where you cloned this repo** (or drop the `npm link` CLI on `PATH`
and it just works).

## Configuration (env / options)

| Option / Env | Default | Meaning |
|---|---|---|
| `chromePath` / `CHROME_PATH` | auto-detect | Chrome executable |
| `profileDir` / `GSEARCH_PROFILE` | `~/.dsh-chrome-google` | persistent, dedicated Chrome profile (keeps "verified" cookies) |
| `maxResults` | 8 | organic results to return (max 20) |
| `verifyTimeoutMs` | 150000 | how long to wait for the human to solve a CAPTCHA |
| `autoVerify` | `true` | if `false`, never open a visible window — just report |
| `gl` / `hl` | `us` / `en` | region / language |

## The human-verification flow, step by step

1. Chrome runs the search headless (a dedicated, isolated profile — never your real browser).
2. If results are present → return them (`status: ok`).
3. If Google serves a CAPTCHA:
   - Screenshot it.
   - Open a **visible** Chrome window (same profile) on the verification page.
   - Wait up to `verifyTimeoutMs` for the human to solve it, polling the page.
   - If solved → extract + return results (flagged `verifiedViaHuman: true`).
     If timed out → return `status: verification_required` with the latest screenshot.
4. The verified session persists in the profile, so the next search usually succeeds headless.

## Testing

```sh
npm test
```

Spawns the MCP server, checks the `search` tool is listed, and — if a Chrome binary is
available on the machine — performs a live search with `autoVerify: false`. In environments
without a browser (e.g. CI) the live call is skipped gracefully.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Could not find Chrome` / launch error | Install Chrome/Chromium or set `CHROME_PATH` / `--chrome` |
| Runs as root in a container, sandbox error | The default is `--no-sandbox` (for isolation); if you want the sandbox on, pass `noSandbox: false` |
| CAPTCHA on every search | Keep the dedicated profile (`~/.dsh-chrome-google`) — deleting it resets the "verified" cookies. Datacenter IPs get CAPTCHAs more often. |
| No visible window appears on SSH | Use a machine with a display, or set `autoVerify: false` and solve the CAPTCHA manually in the printed screenshot's browser context. |
| `ECONNREFUSED` / stale lock in the profile | Close all Chrome instances using that profile, then retry (the profile is separate from your personal one). |

## Revert / clean up

- Config: remove the `mcp-google` entry from your DSH profile config.
- Skill: `rm -rf ~/.dsh/skills/google-chrome-search`
- Profile/screenshots: `rm -rf ~/.dsh-chrome-google`

## License

[MIT](./LICENSE)
