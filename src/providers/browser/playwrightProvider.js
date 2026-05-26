/**
 * Playwright browser lifecycle provider.
 */
const {
  launchBrowser,
  getDefaultContextOptions,
  logBrowserConfiguration,
} = require('../../runner/browserLauncher');

module.exports = {
  launchBrowser,
  getDefaultContextOptions,
  logBrowserConfiguration,
};
