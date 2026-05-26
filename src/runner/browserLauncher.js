/**
 * Central browser launcher — single entry point for Playwright browser instances.
 */
const { chromium, firefox, webkit } = require('playwright');
const logger = require('../utils/logger');
const { getResolvedBrowserConfig } = require('../config/browserConfig');
const optimizer = require('./performanceOptimizer');

const ENGINES = { chromium, firefox, webkit };

function isHeadlessMode() {
  try {
    const envConfig = require('../config/envConfig');
    return envConfig.testConfig?.headless ?? false;
  } catch (_) {
    return false;
  }
}

/**
 * Default context options used across test runs and agents.
 * Headed runs use viewport: null so the page fills the maximized window.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function getDefaultContextOptions(overrides = {}) {
  const base = {
    ignoreHTTPSErrors: true,
    javaScriptEnabled: true,
    bypassCSP: true,
    forcedColors: 'none',
    reducedMotion: 'reduce',
  };

  if (!isHeadlessMode()) {
    return {
      ...base,
      viewport: null,
      ...overrides,
    };
  }

  return {
    ...base,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    screen: { width: 1920, height: 1080 },
    ...overrides,
  };
}

/**
 * Maximize the browser window (Chromium / Edge / Chrome via CDP).
 * @param {import('playwright').Page} page
 */
async function maximizeWindow(page) {
  if (isHeadlessMode()) {
    return;
  }
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'maximized' },
    });
  } catch (err) {
    logger.warning(`Could not maximize browser window: ${err.message}`);
  }
}

/**
 * Create a page and maximize the window in headed mode.
 * @param {import('playwright').BrowserContext} context
 * @returns {Promise<import('playwright').Page>}
 */
async function newPage(context) {
  const page = await context.newPage();
  await maximizeWindow(page);
  return page;
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
  newPage,
  maximizeWindow,
  logBrowserConfiguration,
  getResolvedBrowserConfig,
};
