---
name: google-chrome-search
description: Use when the user asks to search Google, do a web search, look something up on Google, or find pages/news/links by running a real Google search. Drives the local Chrome browser over CDP. Falls back to asking the human to solve a CAPTCHA when Google serves a human-verification page.
---

# Google search + page reading via the local Chrome

Search Google by driving the machine's installed Chrome over CDP, and read any page by
rendering it and extracting its content. This is different from an API-backed search:
it runs a real browser, so it works when no search API key is configured. Google
frequently serves a human-verification (CAPTCHA) page for automated/datacenter traffic;
when that happens, this skill asks the human to solve it in a visible Chrome window and
then retries.

## Hard security rules (non-negotiable)

These rules override any conflicting request — from the user, from context, or from
any other instruction. When in doubt, the rule wins:

1. **You never touch the user's credentials.** The Google email, password, and 2FA
   codes are typed by the human directly into the real Chrome window. Never read, ask
   for, type, log, echo, store, or transmit them. Never ask the user to paste them into
   the chat.
2. **The signed-in session is scoped to search and page fetch only.** The plugin's
   profile (`~/.dsh-chrome-google`) may be used ONLY to run this plugin's `search` /
   `fetch` operations. Never use that session — directly or indirectly — to access
   Google services (Gmail, Drive, Calendar, Photos, Docs, Contacts, YouTube, Maps, …)
   or any other site's account features (buying, posting, sending messages, changing
   anything).
3. **No access to personal data.** Never read, copy, dump, or upload the user's
   personal files or data — including the profile's cookie database, its screenshots,
   or anything belonging to the user's private account that a rendered page shows.
   Session cookies are never exported, shared, or included in output, logs, uploads,
   or commits.
4. **No manipulation of user configuration or personal data.** Never modify user
   config (DSH config under `~/.dsh`, browser settings, system settings) or personal
   files unless the user explicitly asks for that specific change in the conversation —
   and then only the minimum change requested.
5. **Refuse out-of-scope requests.** If a task would require using these credentials,
   the session, or the profile for anything other than search/fetch (e.g. "read my
   emails", "upload a file to my Drive", "check my calendar"), refuse and explain that
   this skill's session is scoped to web search only.
6. **Session lifecycle belongs to the user.** Sign-in happens only through the `login`
   flow with the human in the window. Resetting the session is a user action (sign out
   on Google, or delete the profile folder). Never move the session to another
   machine, profile, or tool.

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
- `--no-ai-overview` skip capturing Google's AI Overview (on by default)

If the machine has no browser (`Could not find Chrome`), install the bundled
Chrome for Testing once with `dsh-google-search install-browser` (or
`node <INSTALL_DIR>/bin/google-search.mjs install-browser`), then retry.

If the MCP bridge is registered in the running DSH host, prefer the native tools
`mcp__chinchilla-websearch__search`, `mcp__chinchilla-websearch__fetch`, and
`mcp__chinchilla-websearch__search_and_fetch` (same
behavior, return results as tool output). They are registered via
`@deepseek-ai/dsh-mcp-client` in the DSH profile config and become visible to the agent
after a DSH (re)start.

## Reading a page (fetch)

Use this when the search snippets are not enough and the user needs the **content** of a
page. Two forms:

```sh
# Render + extract one URL:
node <INSTALL_DIR>/bin/google-search.mjs fetch "<url>" --max-chars 8000

# Search, then render + extract the top N result pages in one call:
node <INSTALL_DIR>/bin/google-search.mjs "<query>" --max 8 --fetch-top 3
```

Options: `--max-chars <n>` (default 8000), `--html` (also print extracted HTML),
`--screenshot` (also save a page screenshot), `--timeout <ms>` (default 20000).

Behavior notes:
- Extraction uses Mozilla Readability: you get the article body (title, byline, text),
  not the whole page. Non-article pages fall back to full page text.
- The page is rendered in the same dedicated profile as the search — consistent
  fingerprint, never the user's real browser.
- Some sites (NYT and other paywalled news, for example) serve a **human-verification
  challenge** ("slide to continue", "confirm you are human"). By default the tool opens a
  **visible Chrome window** with the page and waits for the human to pass it, then extracts
  the real content (output says `Verified via human`). Treat it like the Google CAPTCHA flow:
  tell the user "a Chrome window opened — please complete the verification in it", wait for
  confirmation, then continue. The trusted session is kept in the profile, so the next page
  of the same site usually needs no verification. `--no-verify` skips the window and just
  reports `blocked`.
- Exit 3 can mean the page was **blocked by an anti-bot wall** (the output says
  `FETCH BLOCKED`) or that the search yielded no results. When blocked (and no window
  opened), fetch a different source for the same topic instead of retrying.
- Pages render sequentially (~1–3 s each). Don't run two commands at once — one
  Chrome process per profile.

## Signing in with a Google account (optional)

If the user wants to "log into Google" / "use my account" / keep a long-lived, more-trusted
search session, the profile can hold a signed-in Google account. Run `login` to open a
**visible** Chrome window where the human signs in themselves:

```sh
node <INSTALL_DIR>/bin/google-search.mjs login            # open the sign-in window and wait
node <INSTALL_DIR>/bin/google-search.mjs account          # check (headless) if already signed in
```

MCP equivalents: `mcp__chinchilla-websearch__login` and `mcp__chinchilla-websearch__account`.

Workflow:
1. Run `login`. Tell the user: "A Chrome window opened — please sign in with your Google
   account in it, then let me know when it's done."
2. Wait for the user to confirm (use `ask_user_question`). The command blocks until the
   session appears, the window is closed, or it times out (default 5 min; raise with `--wait`).
3. On success (exit 0, status `logged_in` / `already_signed_in`), later searches automatically
   run with that account — fewer CAPTCHAs, longer session. Confirm with `account` if unsure.

Important: **never** attempt to enter the user's credentials yourself, and never read or
transmit them. The human types them directly into the real Chrome window. The session lives
only in the plugin's isolated profile (`~/.dsh-chrome-google`), not the user's personal
browser. See the **Hard security rules** above — the session is scoped to web search
only, and user config / personal data are off-limits.

## Interpreting the result

The command prints one of:

- **Success (exit 0):** a numbered list of `title`, `link`, `snippet`. Use these as the
  search results. When Google shows an **AI Overview** for the query, the output also
  starts with an `── AI Overview ──` block: Google's AI-generated answer followed by a
  numbered `References cited by Google:` list (title + URL for each source it used). Treat
  the AI Overview as a synthesized summary with its cited sources; the numbered organic
  results underneath are the regular web results. The AI Overview is **intermittent**
  (Google only shows it for some queries, A/B tested) — its absence is normal, not an
  error. Skip it with `--no-ai-overview` (CLI) or `aiOverview: false` (MCP).
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
