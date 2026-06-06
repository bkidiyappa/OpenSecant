/**
 * Interactive pause — halt test execution until the operator presses Enter.
 */
const readline = require('readline');
const logger = require('./logger');

/**
 * Normalize a step line (strip leading step numbers).
 * @param {string} step
 * @returns {string}
 */
function normalizeStepText(step) {
  return (step || '').replace(/^\d+\.\s*/, '').trim();
}

/**
 * True when the step is exactly "PAUSE" (case-insensitive).
 * Does not match timed pauses like "Pause for 5 seconds".
 * @param {string} step
 * @returns {boolean}
 */
function isInteractivePauseStep(step) {
  return /^pause$/i.test(normalizeStepText(step));
}

/**
 * Wait for the user to press Enter.
 * @param {string} prompt
 * @returns {Promise<void>}
 */
function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Whether an interactive pause can run in this process.
 * @returns {{ ok: boolean, reason?: string }}
 */
function canRunInteractivePause() {
  if (process.env.OPENSECANT_SKIP_INTERACTIVE_PAUSE === 'true') {
    return { ok: false, reason: 'skip_env' };
  }
  if (logger.isWorkerThread()) {
    return {
      ok: false,
      reason: 'worker',
      message: 'PAUSE requires sequential execution (run without --parallel)',
    };
  }
  if (!process.stdin.isTTY) {
    return {
      ok: false,
      reason: 'not_tty',
      message: 'PAUSE requires an interactive terminal (stdin is not a TTY)',
    };
  }
  return { ok: true };
}

/**
 * Pause execution, log instructions, wait for Enter.
 * @param {string} step — original step text for logging
 * @returns {Promise<{ skipped?: boolean, message: string }>}
 */
async function runInteractivePause(step) {
  const check = canRunInteractivePause();

  if (!check.ok) {
    if (check.reason === 'skip_env') {
      const message = 'Interactive PAUSE skipped (OPENSECANT_SKIP_INTERACTIVE_PAUSE=true)';
      logger.warning('────────────────────────────────────────────────────────');
      logger.warning(message);
      logger.warning('Remove or comment out OPENSECANT_SKIP_INTERACTIVE_PAUSE in .env to enable PAUSE.');
      logger.warning('────────────────────────────────────────────────────────');
      return { skipped: true, message };
    }
    const message = check.message || 'Interactive PAUSE is not available in this environment';
    logger.error(message);
    throw new Error(message);
  }

  const displayStep = normalizeStepText(step) || 'PAUSE';
  logger.warning('────────────────────────────────────────────────────────');
  logger.warning(`TEST PAUSED at step: ${displayStep}`);
  logger.warning('Inspect the application under test in the browser.');
  logger.warning('Make any corrections, then press Enter in this terminal to continue.');
  logger.warning('────────────────────────────────────────────────────────');

  await waitForEnter('\nPress Enter to continue... ');

  const message = 'Interactive pause completed; execution resumed';
  logger.success(message);
  return { message };
}

module.exports = {
  normalizeStepText,
  isInteractivePauseStep,
  canRunInteractivePause,
  runInteractivePause,
};
