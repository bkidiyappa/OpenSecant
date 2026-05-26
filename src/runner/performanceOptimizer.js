/**
 * Performance optimizer module - Functions for optimizing test execution performance
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let envConfig;
try {
  envConfig = require('../config/envConfig');
} catch (_) {
  envConfig = { testConfig: {} };
}

/**
 * Cache for selectors to avoid repeated file reads
 */
const selectorsCache = {
  data: null,
  lastModified: 0
};

/**
 * Get selectors with caching
 * @param {string} selectorsPath - Path to selectors.json file
 * @returns {Object} Parsed selectors object
 */
function getCachedSelectors(selectorsPath) {
  try {
    // Check if file has been modified since last read
    const stats = fs.statSync(selectorsPath);
    
    if (!selectorsCache.data || stats.mtimeMs > selectorsCache.lastModified) {
      logger.info('Loading selectors from file (cache miss or file updated)');
      selectorsCache.data = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));
      selectorsCache.lastModified = stats.mtimeMs;
    } else {
      logger.info('Using cached selectors (file unchanged)');
    }
    
    return selectorsCache.data;
  } catch (error) {
    logger.error(`Error reading selectors: ${error.message}`);
    throw error;
  }
}

/**
 * Cache for test cases to avoid repeated file reads
 */
const testCaseCache = new Map();

/**
 * Get test case with caching
 * @param {string} testCasePath - Path to test case file
 * @param {Function} readTestCase - Function to read test case
 * @returns {Object} Parsed test case
 */
function getCachedTestCase(testCasePath, readTestCase) {
  try {
    // Check if file has been modified since last read
    const stats = fs.statSync(testCasePath);
    const cachedItem = testCaseCache.get(testCasePath);
    
    if (!cachedItem || stats.mtimeMs > cachedItem.lastModified) {
      logger.info(`Loading test case from file: ${path.basename(testCasePath)} (cache miss or file updated)`);
      const testCase = readTestCase(testCasePath);
      testCaseCache.set(testCasePath, {
        data: testCase,
        lastModified: stats.mtimeMs
      });
      return testCase;
    } else {
      logger.info(`Using cached test case: ${path.basename(testCasePath)} (file unchanged)`);
      return cachedItem.data;
    }
  } catch (error) {
    logger.error(`Error reading test case: ${error.message}`);
    throw error;
  }
}

/**
 * Optimize browser launch options based on system capabilities
 * @returns {Object} Optimized browser launch options
 */
function getOptimizedBrowserOptions(browserName = 'edge') {
  const testConfig = envConfig.testConfig || {};

  // 1. Define realistic, modern human User-Agents per browser type
  const userAgents = {
    chromium: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    webkit: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
  };

  // Base configurations
  const options = {
    headless: testConfig.headless ?? false,
    slowMo: testConfig.slowMo ?? 0,
    
    // 2. Inject matching user agent to avoid mismatched browser identity checks
    userAgent: userAgents[browserName] || userAgents.chromium,
    
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized', // Replaces fixed window sizes which trigger bot alerts
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      '--disable-gpu-vsync',
      '--disable-composited-antialiasing',
      '--force-device-scale-factor=1'
    ]
  };
  
  // Check available system memory to adjust browser options
  try {
    const os = require('os');
    const totalMemory = os.totalmem() / (1024 * 1024 * 1024); // Convert to GB
    
    if (totalMemory < 4) {
      logger.warning('Low memory system detected, optimizing browser options');
      options.args.push(
        '--disable-gpu',
        '--disable-extensions',
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
        '--disable-accelerated-video-encode'
      );
    } else if (totalMemory >= 16) {
      logger.info('High memory system detected, using performance settings');
    }
  } catch (error) {
    logger.warning(`Could not determine system memory: ${error.message}`);
  }
  
  return options;
}
  

/**
 * Clear cache to free up memory
 */
function clearCache() {
  selectorsCache.data = null;
  selectorsCache.lastModified = 0;
  testCaseCache.clear();
  logger.info('Cache cleared');
}

module.exports = {
  getCachedSelectors,
  getCachedTestCase,
  getOptimizedBrowserOptions,
  clearCache
};
