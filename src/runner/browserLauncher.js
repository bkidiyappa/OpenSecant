/**
 * Central browser launcher — single entry point for Playwright browser instances.
 */
const { chromium, firefox, webkit } = require('playwright');
const logger = require('../utils/logger');
const { getResolvedBrowserConfig } = require('../config/browserConfig');
const optimizer = require('./performanceOptimizer');

const ENGINES = { chromium, firefox, webkit };

/**
 * Default context options used across test runs and agents.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function getDefaultContextOptions(overrides = {}) {
  return {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    bypassCSP: true,
    forcedColors: 'none',
    reducedMotion: 'reduce',
    screen: { width: 1920, height: 1080 },
    ...overrides,
  };
}

/**
 * Launch a browser using the configured engine/channel.
 * @param {Object} [extraLaunchOptions] — merged on top of optimized defaults
 * @param {string} [browserOverride] — force a specific browser key
 * @returns {Promise<import('playwright').Browser>}
 */
async function launchBrowser(extraLaunchOptions = {}, browserOverride) {
  const config = getResolvedBrowserConfig(browserOverride);
  const engine = ENGINES[config.engine];

  if (!engine) {
    throw new Error(`Unsupported Playwright engine: ${config.engine}`);
  }

  const launchOptions = {
    ...optimizer.getOptimizedBrowserOptions(),
    ...extraLaunchOptions,
  };

  if (config.channel) {
    launchOptions.channel = config.channel;
  }

  const channelInfo = config.channel ? ` (channel: ${config.channel})` : '';
  logger.info(`Launching browser: ${config.displayName} [${config.engine}${channelInfo}]`);

  try {
    return await engine.launch(launchOptions);
  } catch (err) {
    const hint = config.channel
      ? ` Ensure ${config.displayName} is installed, or use --browser=chromium for the bundled browser.`
      : ` Run "npx playwright install ${config.engine}" if browsers are missing.`;
    throw new Error(`Failed to launch ${config.displayName}: ${err.message}.${hint}`);
  }
}

/**
 * Log the active browser configuration (call once at startup).
 */
function logBrowserConfiguration() {
  const config = getResolvedBrowserConfig();
  logger.system(`Browser: ${config.displayName} (${config.key})`);
}

module.exports = {
  launchBrowser,
  getDefaultContextOptions,
  logBrowserConfiguration,
  getResolvedBrowserConfig,
};
