/**
 * Playwright browser lifecycle provider.
 */
const {
  launchBrowser,
  getDefaultContextOptions,
  newPage,
  logBrowserConfiguration,
} = require('../../runner/browserLauncher');

module.exports = {
  launchBrowser,
  getDefaultContextOptions,
  newPage,
  logBrowserConfiguration,
};
