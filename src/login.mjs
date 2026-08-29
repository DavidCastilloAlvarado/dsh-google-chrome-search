/**
 * dsh-google-chrome-search — Google account login.
 *
 * Opens a VISIBLE Chrome window on the plugin's dedicated persistent profile
 * pointed at Google's account page, and waits for the human to sign in with
 * their own Google account. The resulting session cookies (SID / SSID on
 * .google.com) are stored in that profile, so all later searches run as that
 * real, signed-in account — Google trusts those far more than anonymous
 * automated traffic, which makes CAPTCHAs much rarer and the session last a
 * long time (until Google expires it or the profile is reset).
 *
 * Security model:
 *  - The agent NEVER sees or handles credentials. The human types them
 *    directly into a real Chrome window on their own machine.
 *  - Only session cookies end up on disk — in the plugin's own profile
 *    (~/.dsh-chrome-google by default), never in the user's personal browser.
 *  - Anyone with access to that profile dir on that machine can use the
 *    session while it is valid; treat the profile like a cached password.
 *    Deleting the profile (or signing out from Google) revokes it.
 *
 * Public API: `googleLogin(options)`, `checkGoogleAccount(options)`.
 */

import { launchChrome, defaultProfileDir } from './search.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Cookie names that indicate a signed-in Google session on .google.com. */
const SESSION_COOKIE_NAMES = ['SID', 'SSID', 'SIDCC']

const DEFAULT_START_URL = 'https://accounts.google.com/SignOutOptions'

/** Signed-in Google session cookies among a list of cookies. */
function findSessionCookies(cookies) {
  return (cookies || []).filter(
    (c) => SESSION_COOKIE_NAMES.includes(c.name) && /\.google\.com$/i.test(c.domain || '')
  )
}

/**
 * Best-effort: read the signed-in account's label (usually its email) from
 * the rendered page. The SignOutOptions page shows the account email in its
 * text; the Google homepage shows it in the avatar's alt/aria-label.
 * Never throws — returns null when nothing is found.
 */
async function readAccountLabel(page) {
  try {
    return await page.evaluate(() => {
      const text = (document.body && document.body.innerText) || ''
      const m = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)
      if (m) return m[0]
      const candidates = [
        'img[alt*="@"]',
        '[aria-label*="@"]',
        'img.K9eZLe',
        'div[role="img"][aria-label]',
      ]
      for (const sel of candidates) {
        const el = document.querySelector(sel)
        if (el) {
          const t = (el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim()
          if (t) return t
        }
      }
      return null
    })
  } catch {
    return null
  }
}

/**
 * True if the page (and its browser) is still alive.
 *
 * NOTE: deliberately does NOT use page.evaluate() — the sign-in flow is a
 * sequence of navigations (chooser → email → password → …), and evaluate()
 * throws "execution context was destroyed" mid-navigation, which must not be
 * read as "the human closed the window". Only a closed tab / disconnected
 * browser counts as closed.
 */
function pageAlive(page) {
  try {
    if (page.isClosed()) return false
    const browser = page.browser()
    if (!browser || !browser.isConnected()) return false
    return true
  } catch {
    return false
  }
}

/**
 * Read the Google account cookies from a page without throwing.
 * @returns {Promise<Array>} session cookies (may be empty)
 */
async function readSessionCookies(page) {
  try {
    const cookies = await page.cookies('https://accounts.google.com/', 'https://www.google.com/')
    return findSessionCookies(cookies)
  } catch {
    return []
  }
}

/**
 * Open a VISIBLE Chrome window on the dedicated persistent profile so the
 * human can sign in with their Google account, and wait until the session
 * cookies appear (or the window is closed / the timeout elapses).
 *
 * The agent never sees the credentials — they are typed by the human directly
 * into the real Chrome window. The session persists in the profile afterwards.
 *
 * @param {object} [opts]
 * @param {string} [opts.profileDir]          persistent profile dir (default: GSEARCH_PROFILE / ~/.dsh-chrome-google)
 * @param {string} [opts.chromePath]          Chrome executable
 * @param {boolean} [opts.noSandbox=true]
 * @param {number} [opts.waitMs=300000]       how long to wait for the human to sign in
 * @param {string} [opts.startUrl]            page to open (default: accounts.google.com/SignOutOptions)
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.log]               progress logger
 * @returns {Promise<LoginOutcome>}
 */
export async function googleLogin(opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const profileDir = opts.profileDir || defaultProfileDir()
  const waitMs = opts.waitMs ?? 300_000
  const startUrl = opts.startUrl || DEFAULT_START_URL
  const chromeOpts = { chromePath: opts.chromePath, profileDir, noSandbox: opts.noSandbox }

  const done = (status, extra = {}) => ({
    status,
    profileDir,
    account: extra.account || null,
    cookieCount: extra.cookies ? extra.cookies.length : 0,
    ...extra,
    message: extra.message || '',
  })

  const browser = await launchChrome({ headless: false }, env, chromeOpts)
  try {
    let page = (await browser.pages())[0] || (await browser.newPage())
    log(`opening Google account page in a VISIBLE window: ${startUrl}`)
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})

    // Already signed in? Then there is nothing to do.
    let session = await readSessionCookies(page)
    if (session.length > 0) {
      log('Google account session already present in the profile')
      return done('already_signed_in', {
        account: await readAccountLabel(page),
        cookies: session,
        message:
          'The profile already contains a Google account session — no sign-in was needed. ' +
          'Searches already run with that account.',
      })
    }

    log('Waiting for the human to sign in with their Google account in the opened window…')
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (opts.signal && opts.signal.aborted) throw new Error('login aborted')
      if (!(await pageAlive(page))) {
        return done('closed', {
          message:
            'The Chrome window was closed before the Google sign-in completed. ' +
            'Run "login" again and finish signing in in the opened window.',
        })
      }
      session = await readSessionCookies(page)
      if (session.length > 0) {
        const account = await readAccountLabel(page)
        log('Google sign-in detected — session stored in the profile')
        return done('logged_in', {
          account,
          cookies: session,
          message:
            `Signed in with Google account ${account ? `"${account}"` : '(account)'} in the persistent profile (${profileDir}). ` +
            'All later searches and fetches now run with this account — sessions of a real ' +
            'signed-in account are trusted much more, so CAPTCHAs should become rarer. ' +
            'The session lasts until Google expires it or the profile is deleted.',
        })
      }
      log(`waiting for sign-in… (${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s left)`)
      await sleep(2000)
    }

    return done('timeout', {
      message:
        `The Google sign-in was not completed within ${Math.round(waitMs / 1000)}s. ` +
        'Please finish signing in in the opened Chrome window and re-run login — ' +
        'or simply run the search again; if a sign-in page appears, complete it there.',
    })
  } finally {
    try {
      await browser.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Check whether the persistent profile currently holds a signed-in Google
 * account (headless — no window is opened).
 *
 * @param {object} [opts]
 * @param {string} [opts.profileDir]
 * @param {string} [opts.chromePath]
 * @param {boolean} [opts.noSandbox=true]
 * @param {Function} [opts.log]
 * @returns {Promise<{status:'logged_in'|'not_logged_in', account:string|null, profileDir:string, cookieCount:number, message:string}>}
 */
export async function checkGoogleAccount(opts = {}) {
  const env = process.env
  const log = opts.log || (() => {})
  const profileDir = opts.profileDir || defaultProfileDir()
  const chromeOpts = { chromePath: opts.chromePath, profileDir, noSandbox: opts.noSandbox }

  const browser = await launchChrome({ headless: true }, env, chromeOpts)
  try {
    const page = (await browser.pages())[0] || (await browser.newPage())
    await page
      .goto('https://www.google.com', { waitUntil: 'domcontentloaded', timeout: 30000 })
      .catch(() => {})
    const session = await readSessionCookies(page)
    if (session.length === 0) {
      return {
        status: 'not_logged_in',
        account: null,
        profileDir,
        cookieCount: 0,
        message:
          'No Google account session in the profile. Run the "login" tool to sign in with ' +
          'a Google account for a more trusted (and personalized) search session.',
      }
    }
    const account = await readAccountLabel(page)
    return {
      status: 'logged_in',
      account: account || null,
      profileDir,
      cookieCount: session.length,
      message: `The profile is signed in with Google account ${account ? `"${account}"` : ''}.`,
    }
  } finally {
    try {
      await browser.close()
    } catch {
      /* already closed */
    }
  }
}
