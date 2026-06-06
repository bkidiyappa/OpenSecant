/**
 * Self-healing engine: locator resolver → LLM fallback with retries.
 */
const logger = require('../../utils/logger');
const { getStepStore } = require('../../store/stepStore');
const { tryActionLibrary, getActionType } = require('../locator/locatorResolver');
const { captureHybridInputData } = require('../locator/pageDataCapture');
const { filterRelevantElements } = require('../locator/elementFiltering');
const { config: llmConfig } = require('../../providers/llm/llmConfig');
const { sanitizePlaywrightCode, isValidPlaywrightCode } = require('../../providers/llm/responseParser');
const { parseOrdinalLinkStep, buildOrdinalLinkLocatorFallbacks } = require('../../utils/ordinalLinkStep');
const { suggestAlternativeLocators } = require('./fallbackSelector');
const { getMaxHealRounds } = require('./retryStrategy');
const { summarizeExecError } = require('../../utils/execError');

const VERBOSE = process.env.OPENSECANT_VERBOSE === 'true';

function truncateCode(code, max = 80) {
  const oneLine = code.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** Format Playwright code for console logs. */
function formatLocatorForLog(code, max = 500) {
  return truncateCode(code, max);
}

/**
 * Last-resort click locators from plain-English target text.
 * @param {string} stepDescription
 * @returns {string[]}
 */
function buildTextClickFallback(stepDescription) {
  const ord = parseOrdinalLinkStep(stepDescription);
  if (ord) {
    return buildOrdinalLinkLocatorFallbacks(ord.ordinal, ord.text).filter(isValidPlaywrightCode);
  }

  const match = stepDescription.match(/^click (?:on |the )?(.+?)(?:\s+button)?$/i);
  if (!match) return [];

  const target = match[1].trim();
  if (!target) return [];

  return [
    `await page.getByRole('link', { name: ${JSON.stringify(target)}, exact: false }).first().click();`,
    `await page.getByRole('button', { name: ${JSON.stringify(target)}, exact: false }).first().click();`,
    `await page.getByText(${JSON.stringify(target)}, { exact: false }).first().click();`,
  ].filter(isValidPlaywrightCode);
}

async function tryCandidates(candidates, label, page, stepDescription, stepStore, execCode) {
  if (!candidates || candidates.length === 0) return null;

  const validCandidates = candidates.filter((code) => {
    const ok = isValidPlaywrightCode(code);
    if (!ok && VERBOSE) {
      logger.warning(`${label}: skipping invalid candidate: ${truncateCode(code)}`);
    }
    return ok;
  });

  const skipped = candidates.length - validCandidates.length;
  if (skipped > 0) {
    logger.warning(`${label}: skipped ${skipped} malformed suggestion(s)`);
  }
  if (validCandidates.length === 0) return null;

  logger.info(`${label}: trying ${validCandidates.length} candidate(s)`);

  let lastError = '';
  let lastCode = '';
  for (let i = 0; i < validCandidates.length; i++) {
    const code = validCandidates[i];
    const attemptLabel = `${label} ${i + 1}/${validCandidates.length}`;
    logger.info(`${attemptLabel} → ${formatLocatorForLog(code)}`);

    try {
      await execCode(page, code);
      if (isMeaningfulCode(code, stepDescription)) stepStore.set(stepDescription, code);
      logger.success(`${attemptLabel} worked → ${formatLocatorForLog(code)}`);
      return { success: true, code, source: label.includes('LLM') ? 'llm' : 'library' };
    } catch (err) {
      const isWaitTimeout = /waitForLoadState|waitForSelector|waitForNavigation|waitForURL/.test(code) &&
        /[Tt]imeout/.test(err.message);
      const hasAction = /\.click\(|\.fill\(|\.check\(|\.selectOption\(|\.press\(|\.type\(|toBeVisible|toHaveText|toContainText/.test(code);

      if (isWaitTimeout && hasAction && isMeaningfulCode(code, stepDescription)) {
        stepStore.set(stepDescription, code);
        logger.success(`${attemptLabel} worked (wait timeout ignored) → ${formatLocatorForLog(code)}`);
        return { success: true, code, source: label.includes('LLM') ? 'llm' : 'library' };
      }

      lastError = summarizeExecError(err);
      lastCode = code;
      logger.warning(`${attemptLabel} failed: ${lastError}`);
    }
  }

  if (lastCode) {
    logger.warning(`${label}: all ${validCandidates.length} failed — last locator: ${formatLocatorForLog(lastCode)}`);
  } else {
    logger.warning(`${label}: all ${validCandidates.length} failed — ${lastError}`);
  }
  return null;
}

async function waitForPageStable(page) {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch (_) { /* proceed */ }

  try { await page.waitForTimeout(1500); } catch (_) { return; }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 });
  } catch (_) { /* proceed */ }

  try {
    await waitForDomSettlement(page, 3000);
  } catch (_) { /* proceed */ }
}

async function waitForDomSettlement(page, timeout = 3000) {
  const SELECTOR = 'input, textarea, select, button, a, [role], [data-testid], [testdataid]';
  const INTERVAL = 500;
  const STABLE_CHECKS = 2;

  let prevCount = -1;
  let stableCount = 0;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const count = await page.evaluate((sel) =>
        document.querySelectorAll(sel).length, SELECTOR);
      if (count === prevCount && count > 0) {
        stableCount++;
        if (stableCount >= STABLE_CHECKS) return;
      } else {
        stableCount = 0;
      }
      prevCount = count;
    } catch (_) { return; }
    try {
      await page.waitForTimeout(INTERVAL);
    } catch (_) { return; }
  }
}

function isMeaningfulCode(code, stepDescription) {
  const ACTION_RE = /\.click\(|\.fill\(|\.check\(|\.uncheck\(|\.selectOption\(|\.press\(|\.type\(|\.goto\(|\.setInputFiles\(|\.hover\(|\.dblclick\(|\.dragTo\(|toBeVisible|toHaveText|toContainText|toBeChecked|toHaveValue/;
  if (ACTION_RE.test(code)) return true;

  const stepLower = (stepDescription || '').toLowerCase();
  if (/^wait\b|^pause\b|^delay\b/.test(stepLower)) return true;

  if (VERBOSE) {
    logger.warning(`Rejecting no-op code for "${stepDescription}": ${truncateCode(code)}`);
  }
  return false;
}

async function healStep(page, step, originalCode, errorMessage, runDir, execCode) {
  const stepDescription = step.replace(/^\d+\.\s*/, '');
  const stepStore = getStepStore();
  const maxRounds = getMaxHealRounds();

  for (let round = 0; round < maxRounds; round++) {
    const roundLabel = round === 0 ? 'initial' : `retry-${round}`;

    if (round === 0) {
      const actionType = getActionType(stepDescription);
      if (VERBOSE) {
        logger.info(`Healing [${roundLabel}] ${stepDescription} (action: ${actionType})`);
      }

      const ELEMENT_FREE_ACTIONS = new Set(['navigate', 'hardWait', 'clickOrdinalLink']);
      if (ELEMENT_FREE_ACTIONS.has(actionType)) {
        const fastCandidates = tryActionLibrary(stepDescription, []) || [];
        if (fastCandidates.length > 0) {
          logger.info(`Action library (${actionType}): ${fastCandidates.length} candidate(s) before page capture`);
        }
        const fastResult = await tryCandidates(
          fastCandidates, 'Locator', page, stepDescription, stepStore, execCode
        );
        if (fastResult) return fastResult;
      }

      try {
        const hybridData = await captureHybridInputData(page, null, stepDescription);
        const focusedElements = filterRelevantElements(hybridData || [], stepDescription) || [];
        const focusedCandidates = tryActionLibrary(stepDescription, focusedElements) || [];
        const broadCandidates = focusedElements.length < hybridData.length
          ? (tryActionLibrary(stepDescription, hybridData) || [])
          : [];
        const candidates = [...new Set([...focusedCandidates, ...broadCandidates])];

        const libResult = await tryCandidates(
          candidates, 'Locator', page, stepDescription, stepStore, execCode
        );
        if (libResult) return libResult;
      } catch (err) {
        logger.warning(`Locator resolver error: ${summarizeExecError(err)}`);
      }
    }

    await waitForPageStable(page);

    const LLM_TIMEOUT_MS = llmConfig.common.timeout || 180000;
    const enrichedError = round === 0
      ? (errorMessage || 'New step — no existing code')
      : `${errorMessage}. Previous suggestions failed (round ${round}).`;

    try {
      const suggestionsPromise = suggestAlternativeLocators(
        page,
        stepDescription,
        originalCode || '// No existing code — generate from scratch',
        enrichedError,
        null,
        runDir
      );
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`LLM timed out after ${LLM_TIMEOUT_MS / 1000}s`)), LLM_TIMEOUT_MS)
      );
      const suggestions = await Promise.race([suggestionsPromise, timeoutPromise]);

      if (!suggestions || suggestions.length === 0) continue;

      const codes = suggestions
        .map((raw) => sanitizePlaywrightCode(typeof raw === 'string' ? raw : raw?.code || ''))
        .filter(Boolean);

      if (codes.length === 0) {
        logger.warning(`LLM [${roundLabel}]: no valid Playwright suggestions (response may be truncated — try a larger model)`);
      } else {
        const llmResult = await tryCandidates(
          codes, 'LLM', page, stepDescription, stepStore, execCode
        );
        if (llmResult) return llmResult;
      }

      const textFallbacks = buildTextClickFallback(stepDescription);
      if (textFallbacks.length > 0) {
        const fbResult = await tryCandidates(
          textFallbacks, 'Text fallback', page, stepDescription, stepStore, execCode
        );
        if (fbResult) return fbResult;
      }
    } catch (llmErr) {
      logger.error(`LLM error [${roundLabel}]: ${summarizeExecError(llmErr)}`);
    }
  }

  return null;
}

module.exports = {
  healStep,
  waitForPageStable,
  isMeaningfulCode,
};
