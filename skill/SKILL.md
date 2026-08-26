---
name: google-chrome-search
description: Use when the user asks to search Google, do a web search, look something up on Google, or find pages/news/links by running a real Google search. Drives the local Chrome browser over CDP. Falls back to asking the human to solve a CAPTCHA when Google serves a human-verification page.
---

# Google search via the local Chrome

Search Google by driving the machine's installed Chrome over CDP. This is different
from an API-backed search: it runs a real browser, so it works when no search API key
is configured. Google frequently serves a human-verification (CAPTCHA) page for
automated/datacenter traffic; when that happens, this skill asks the human to solve it
in a visible Chrome window and then retries.

## How to run a search

Primary path — the CLI:

```sh
node <INSTALL_DIR>/bin/google-search.mjs "<query>" --max 8
```

Replace `<INSTALL_DIR>` with the directory where the `dsh-google-chrome-search` repo
is installed on this machine (e.g. `/home/<user>/dsh-google-chrome-search`). If the
CLI was linked globally (`npm link`), you can just run `dsh-google-search "<query>"`.

Useful options:
- `--max <n>`  number of organic results (default 8, max 20)
- `--gl <code>` / `--hl <code>`  region / language (defaults `us` / `en`)
- `--json`     print the raw JSON outcome instead of the readable list
- `--no-verify` do NOT open a visible window; just report that verification is required
- `--verify-timeout <ms>` how long to wait for the human to solve a CAPTCHA (default 150000)

If the MCP bridge is registered in the running DSH host, prefer the native tool
`mcp__google__search` (same behavior, returns results as tool output). It is registered
via `@deepseek-ai/dsh-mcp-client` in the DSH profile config and becomes visible to the
agent after a DSH (re)start.

## Interpreting the result

The command prints one of:

- **Success (exit 0):** a numbered list of `title`, `link`, `snippet`. Use these as the
  search results.
- **Verification required (exit 2):** Google served a CAPTCHA. The JSON/status includes a
  `screenshot` path and a message.
- **No results (exit 3):** the rendered page did not yield organic results — it may be an
  undetected verification interstitial. Check the `screenshot` if present and retry.

## The human-verification workflow (important)

When the result is `verification_required`:

1. A **visible Chrome window** has been opened on the machine pointing at Google's
   verification page (this is the "ask the human" step). Tell the user:
   "Google asked for human verification — a Chrome window has opened. Please solve the
   'I'm not a robot' check in that window, then let me know when it's done."
2. Show the user the returned `screenshot` (read the image) so they can see exactly what
   to solve.
3. Wait for the user to confirm they completed it (use `ask_user_question`).
4. Re-run the same search command. Because the verified session is kept in the
   persistent Chrome profile (`~/.dsh-chrome-google`), the retry usually succeeds without
   another CAPTCHA.

Notes:
- The tool blocks until the human solves the CAPTCHA or the verify-timeout elapses. Keep
  the verify-timeout generous (default 150s) so the human has time.
- Never try to click/solve the CAPTCHA programmatically or bypass it; always hand it to the
  human.
- A dedicated Chrome profile is used, so the user's real browser is never touched.
