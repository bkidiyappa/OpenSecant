#!/usr/bin/env node
/**
 * OpenSecant — main package entry point.
 */
require('./utils/loadEnv')();

const { expect } = require('playwright');
const logger = require('./utils/logger');
const { main } = require('./cli');

logger.overrideConsole();

try {
  const env = require('./config/envConfig');
  logger.system(`Environment: ${env.currentEnv}`);
  logger.system(`Base URL: ${env.baseUrl}`);

  if ((process.env.DEBUG_PROMPTS || '').toLowerCase() === 'true') {
    const { paths } = require('./config/frameworkConfig');
    logger.system(`DEBUG_PROMPTS enabled → ${paths.debugPrompts}`);
  }

  const { logBrowserConfiguration } = require('./providers/browser/playwrightProvider');
  logBrowserConfiguration();

  global.env = env;
  global.expect = expect;

  main()
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((err) => {
      logger.error('Unhandled error:', err);
      process.exit(1);
    });
} catch (err) {
  logger.error('Failed to start OpenSecant:', err);
  process.exit(1);
}
