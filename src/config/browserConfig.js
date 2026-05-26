/**
 * Browser configuration — resolve engine/channel from CLI, env, or defaults.
 *
 * Supported names (case-insensitive):
 *   chromium          — Playwright bundled Chromium (default)
 *   chrome            — Google Chrome (installed)
 *   chrome-beta, chrome-dev
 *   edge, msedge      — Microsoft Edge (installed)
 *   msedge-beta, msedge-dev
 *   firefox
 *   webkit, safari    — WebKit (Safari engine on macOS)
 */

const BROWSER_DEFINITIONS = {
  chromium: { engine: 'chromium', channel: null, displayName: 'Chromium (bundled)' },
  chrome: { engine: 'chromium', channel: 'chrome', displayName: 'Google Chrome' },
  'chrome-beta': { engine: 'chromium', channel: 'chrome-beta', displayName: 'Google Chrome Beta' },
  'chrome-dev': { engine: 'chromium', channel: 'chrome-dev', displayName: 'Google Chrome Dev' },
  msedge: { engine: 'chromium', channel: 'msedge', displayName: 'Microsoft Edge' },
  edge: { engine: 'chromium', channel: 'msedge', displayName: 'Microsoft Edge' },
  'msedge-beta': { engine: 'chromium', channel: 'msedge-beta', displayName: 'Microsoft Edge Beta' },
  'msedge-dev': { engine: 'chromium', channel: 'msedge-dev', displayName: 'Microsoft Edge Dev' },
  firefox: { engine: 'firefox', channel: null, displayName: 'Firefox' },
  webkit: { engine: 'webkit', channel: null, displayName: 'WebKit' },
  safari: { engine: 'webkit', channel: null, displayName: 'WebKit (Safari engine)' },
};

/** Aliases → canonical browser key */
const BROWSER_ALIASES = {
  'google-chrome': 'chrome',
  'google chrome': 'chrome',
  'microsoft-edge': 'msedge',
  'microsoft edge': 'msedge',
};

const DEFAULT_BROWSER = 'chromium';

/**
 * Normalize user input to a canonical browser key.
 * @param {string} name
 * @returns {string}
 */
function normalizeBrowserName(name) {
  if (!name || typeof name !== 'string') {
    return DEFAULT_BROWSER;
  }
  const trimmed = name.trim().toLowerCase();
  const aliased = BROWSER_ALIASES[trimmed] || trimmed;
  return aliased;
}

/**
 * Parse browser from process.argv (--browser=chrome or --browser chrome).
 * @returns {string|null}
 */
function getBrowserFromArgv() {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--browser=')) {
      return arg.split('=').slice(1).join('=');
    }
    if (arg === '--browser' && i + 1 < process.argv.length) {
      const next = process.argv[i + 1];
      if (!next.startsWith('--')) {
        return next;
      }
    }
  }
  return null;
}

/**
 * Resolve the active browser name from argv, env, or default.
 * @param {string} [override] — explicit override (e.g. from testConfig)
 * @returns {string} canonical browser key
 */
function resolveBrowserName(override) {
  const fromArgv = getBrowserFromArgv();
  if (fromArgv) {
    return normalizeBrowserName(fromArgv);
  }

  const fromEnv = process.env.OPENSECANT_BROWSER || process.env.BROWSER;
  if (fromEnv) {
    return normalizeBrowserName(fromEnv);
  }

  if (override) {
    return normalizeBrowserName(override);
  }

  try {
    const envConfig = require('./envConfig');
    if (envConfig.testConfig?.browser) {
      return normalizeBrowserName(envConfig.testConfig.browser);
    }
  } catch (_) {
    // envConfig not loaded yet
  }

  return DEFAULT_BROWSER;
}

/**
 * Get full browser definition for the current configuration.
 * @param {string} [override]
 * @returns {{ key: string, engine: string, channel: string|null, displayName: string }}
 */
function getResolvedBrowserConfig(override) {
  const key = resolveBrowserName(override);
  const def = BROWSER_DEFINITIONS[key];

  if (!def) {
    const supported = Object.keys(BROWSER_DEFINITIONS).join(', ');
    console.warn(
      `Unknown browser "${key}". Supported: ${supported}. Using ${DEFAULT_BROWSER}.`
    );
    return { key: DEFAULT_BROWSER, ...BROWSER_DEFINITIONS[DEFAULT_BROWSER] };
  }

  return { key, ...def };
}

/**
 * List supported browser keys for help text.
 * @returns {string[]}
 */
function getSupportedBrowsers() {
  return Object.keys(BROWSER_DEFINITIONS);
}

module.exports = {
  DEFAULT_BROWSER,
  BROWSER_DEFINITIONS,
  normalizeBrowserName,
  resolveBrowserName,
  getResolvedBrowserConfig,
  getSupportedBrowsers,
};
