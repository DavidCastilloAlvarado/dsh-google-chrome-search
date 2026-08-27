/**
 * Optional bundled browser: Chrome for Testing, installed via
 * `dsh-google-search install-browser`.
 *
 * The download goes into `<profileDir>/browser/` (next to the persistent
 * Chrome profile) and a small marker, `<profileDir>/browser-info.json`,
 * records the build id so `resolveChromePath()` (search.mjs) can pick the
 * executable up automatically. This makes the plugin self-contained on
 * machines with no system browser — the "use your local Chrome" default
 * (CHROME_PATH / system candidates) still takes precedence per the
 * resolution chain in search.mjs.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  Browser,
  computeExecutablePath,
  detectBrowserPlatform,
  install,
  resolveBuildId,
} from '@puppeteer/browsers'

export const BROWSER_MARKER_FILE = 'browser-info.json'

/** Directory that holds the downloaded Chrome for Testing build. */
export function bundledBrowserDir(profileDir) {
  return path.join(profileDir, 'browser')
}

export function bundledInfoFile(profileDir) {
  return path.join(profileDir, BROWSER_MARKER_FILE)
}

/**
 * Find the bundled Chrome for Testing (if installed) for a profile dir.
 * @returns {string|null} absolute path to the executable, or null
 */
export function findBundledBrowser(profileDir) {
  try {
    const info = JSON.parse(fs.readFileSync(bundledInfoFile(profileDir), 'utf8'))
    if (!info || !info.buildId) return null
    const exe = computeExecutablePath({
      browser: Browser.CHROME,
      buildId: info.buildId,
      cacheDir: bundledBrowserDir(profileDir),
    })
    return fs.existsSync(exe) ? exe : null
  } catch {
    return null
  }
}

/**
 * Download the latest stable Chrome for Testing into `<profileDir>/browser/`.
 * If one is already installed and `force` is false, it is a no-op.
 *
 * @param {{profileDir: string, force?: boolean, log?: (msg: string) => void}} opts
 * @returns {Promise<{executablePath: string, installed: boolean, buildId: string, platform: string}>}
 */
export async function installBrowser({ profileDir, force = false, log = () => {} }) {
  if (!profileDir) throw new Error('installBrowser: profileDir is required')

  const existing = findBundledBrowser(profileDir)
  if (existing && !force) {
    log(`Bundled browser already installed: ${existing}`)
    const info = JSON.parse(fs.readFileSync(bundledInfoFile(profileDir), 'utf8'))
    return { executablePath: existing, installed: false, buildId: info.buildId, platform: info.platform }
  }

  let platform
  try {
    platform = detectBrowserPlatform()
  } catch (err) {
    throw new Error(
      `Unsupported platform for bundled browser (${err.message}). ` +
        'Install a system Chrome/Chromium and set CHROME_PATH, or run on Linux/macOS/Windows (x64 or arm64).'
    )
  }

  const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable')
  log(`Downloading Chrome for Testing ${buildId} (${platform}) — ~170 MB, one time…`)

  const cacheDir = bundledBrowserDir(profileDir)
  fs.mkdirSync(cacheDir, { recursive: true })

  try {
    await install({ browser: Browser.CHROME, buildId, cacheDir })
  } catch (err) {
    throw new Error(
      `Browser download failed (${err.message}). ` +
        'Check network access to storage.googleapis.com, or install a system browser and set CHROME_PATH.'
    )
  }

  const exe = computeExecutablePath({ browser: Browser.CHROME, buildId, cacheDir })
  if (!fs.existsSync(exe)) {
    throw new Error(`Download finished but the executable is missing at: ${exe}`)
  }

  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(
    bundledInfoFile(profileDir),
    JSON.stringify({ buildId, platform, installedAt: new Date().toISOString() }, null, 2)
  )

  log(`Installed: ${exe}`)
  return { executablePath: exe, installed: true, buildId, platform }
}

/** Remove the bundled browser (the profile dir and cookies are untouched). */
export function uninstallBrowser(profileDir, log = () => {}) {
  const dir = bundledBrowserDir(profileDir)
  let removed = false
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true })
    removed = true
  }
  const marker = bundledInfoFile(profileDir)
  if (fs.existsSync(marker)) {
    fs.rmSync(marker, { force: true })
    removed = true
  }
  log(removed ? `Removed bundled browser under ${dir}` : 'No bundled browser found to remove')
  return removed
}
