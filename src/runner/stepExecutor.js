/**
 * Step executor — StepStore → healing engine (locator + LLM).
 */
const logger = require('../utils/logger');
const { generateUniqueAlphabeticString } = require('../utils/uniqueStringGenerator');
const { expect } = require('@playwright/test');
const { getStepStore } = require('../store/stepStore');
const { sanitizePlaywrightCode } = require('../providers/llm/responseParser');
const { healStep, waitForPageStable } = require('../engines/healing/healingEngine');
const { summarizeExecError } = require('../utils/execError');
const { isInteractivePauseStep, runInteractivePause } = require('../utils/interactivePause');
const { isOrdinalLinkStepCodeValid, parseOrdinalLinkStep } = require('../utils/ordinalLinkStep');

function truncateForLog(code, max = 120) {
  const oneLine = (code || '').replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function execCode(page, code) {
  const cleaned = sanitizePlaywrightCode(code);
  if (!cleaned) {
    throw new Error('Empty or invalid Playwright code after sanitization');
  }
  const fn = new Function(
    'page', 'env', 'generateUniqueAlphabeticString', 'expect',
    `return (async () => { ${cleaned} })();`
  );
  await fn(page, global.env, generateUniqueAlphabeticString, expect);
}

function isPartialSuccess(code, error) {
  const isWaitTimeout = /waitForLoadState|waitForNavigation|waitForURL/.test(error.message)
    && /[Tt]imeout/.test(error.message);
  const hasAction = /\.click\(|\.fill\(|\.check\(|\.selectOption\(|\.press\(|\.type\(/.test(code);
  return isWaitTimeout && hasAction;
}

async function stabilizeIfNeeded(page, step) {
  const stepLower = step.toLowerCase();
  const causesNavigation = /click|submit|continue|search|book|select.*button/i.test(stepLower)
    && !/(checkbox|radio|dropdown|field|input)/i.test(stepLower);
  if (causesNavigation) {
    logger.info('Step may cause navigation, waiting for page to stabilize...');
    await waitForPageStable(page);
  }
}

async function executeStep(page, step, runDir = null) {
  try {
    const stepNameClean = step.replace(/^\d+\.\s*/, '').trim();

    if (isInteractivePauseStep(step)) {
      const pauseResult = await runInteractivePause(step);
      return {
        success: true,
        message: pauseResult.message,
        interactivePause: true,
        interactivePauseSkipped: !!pauseResult.skipped,
      };
    }

    const stepStore = getStepStore();
    let code = stepStore.resolve(stepNameClean);
    let stepStoreError = null;

    if (code && !isOrdinalLinkStepCodeValid(stepNameClean, code)) {
      const ord = parseOrdinalLinkStep(stepNameClean);
      logger.warning(
        `StepStore skipped for ordinal link step "${stepNameClean}" — cached code does not match required link index`,
      );
      logger.info(`  Cached (ignored): ${truncateForLog(code)}`);
      code = null;
    }

    if (code) {
      logger.info(`StepStore hit for "${stepNameClean}"`);
      logger.info(`  StepStore locator → ${truncateForLog(code)}`);
      try {
        await execCode(page, code);
        logger.success(`Step executed from StepStore: ${stepNameClean}`);
        await stabilizeIfNeeded(page, step);
        return { success: true, message: `Step executed successfully: ${step}` };
      } catch (error) {
        if (isPartialSuccess(code, error)) {
          logger.warning('Action succeeded, wait timed out — treating as success');
          await waitForPageStable(page);
          return { success: true, message: `Step executed (wait skipped): ${step}` };
        }
        stepStoreError = summarizeExecError(error);
        logger.warning(`StepStore code failed: ${stepStoreError}`);
      }
    } else {
      logger.info(`No StepStore entry for "${stepNameClean}"`);
    }

    const healResult = await healStep(page, step, code, stepStoreError, runDir, execCode);

    if (healResult) {
      const source = healResult.source || 'unknown';
      logger.info(`Step resolved via ${source.toUpperCase()}`);
      await stabilizeIfNeeded(page, step);
      return {
        success: true,
        message: `Step ${code ? 'healed' : 'generated'} via ${source}: ${step}`,
        usedAlternative: !!code,
        alternativeCode: healResult.code,
        source,
      };
    }

    logger.error(`Step failed — stopping test: ${step}`);
    return { success: false, error: `All resolution methods failed for step: ${step}`, stopTest: true };
  } catch (error) {
    return { success: false, error: summarizeExecError(error), stopTest: true };
  }
}

module.exports = {
  executeStep,
};
