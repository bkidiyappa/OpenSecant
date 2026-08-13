/**
 * CLI: interactive recorder with in-page overlay UI.
 *
 *   npx opensecant record <url> [--name <test-name>] [--out <dir>]
 */
const path = require('path');
const logger = require('../utils/logger');
const { runRecordingSession } = require('../engines/recorder/session');
const { paths: frameworkPaths } = require('../config/frameworkConfig');

function showRecordHelp() {
  console.log(`
OpenSecant Recorder — capture actions with an in-page overlay

Usage:
  npx opensecant record <url> [--name <test-name>] [--out <dir>]

Options:
  --name <name>   Output test base name (default: recorded-<timestamp>)
  --out <dir>     Output directory under tests/ or absolute (default: tests/recorded)
  --help          Show this help

Overlay controls (bottom-right of the browser):
  Start              Begin capturing (required — idle until then)
  Pause / Resume     Temporarily ignore page interactions
  Undo               Remove last captured step
  Stop & Save        Write .test file + stepstore + session JSON

Scripted page clicks (FAQ auto-expand, etc.) are ignored (isTrusted filter).

You can also press Ctrl+C in the terminal to save and exit.

Example:
  npx opensecant record https://www.google.com --name smoke/google-search
`);
}

/**
 * @param {string[]} argv
 * @returns {Promise<number|null>} exit code, or null if not a record command
 */
async function handleRecordCommand(argv) {
  const isRecord =
    argv[0] === 'record' ||
    argv.includes('--record');

  if (!isRecord) return null;

  if (argv.includes('--help') || argv.includes('-h')) {
    showRecordHelp();
    return 0;
  }

  let url = null;
  if (argv[0] === 'record') {
    url = argv[1];
  } else {
    const idx = argv.indexOf('--record');
    url = argv[idx + 1];
  }

  if (!url || url.startsWith('--')) {
    logger.error('Usage: npx opensecant record <url> [--name <name>]');
    showRecordHelp();
    return 1;
  }

  const nameIdx = argv.indexOf('--name');
  let testName = nameIdx !== -1 && argv[nameIdx + 1] ? argv[nameIdx + 1] : `recorded-${Date.now()}`;

  const outIdx = argv.indexOf('--out');
  let outputDir = path.join(frameworkPaths.tests, 'recorded');
  if (outIdx !== -1 && argv[outIdx + 1]) {
    const out = argv[outIdx + 1];
    outputDir = path.isAbsolute(out) ? out : path.join(frameworkPaths.tests, out);
  }

  // Allow --name smoke/foo → put under tests/smoke
  if (testName.includes('/') || testName.includes('\\')) {
    const parts = testName.replace(/\\/g, '/').split('/');
    testName = parts.pop();
    const sub = parts.join('/');
    outputDir = path.join(frameworkPaths.tests, sub);
  }

  try {
    const result = await runRecordingSession(url, { testName, outputDir });
    const rel = path.relative(frameworkPaths.tests, result.testFilePath).replace(/\\/g, '/').replace(/\.test$/i, '');
    logger.info(`Re-run with: npx opensecant ${rel}`);
    return 0;
  } catch (err) {
    logger.error(`[Recorder] Failed: ${err.message}`);
    if (err.stack) logger.error(err.stack);
    return 1;
  }
}

module.exports = {
  handleRecordCommand,
  showRecordHelp,
};
