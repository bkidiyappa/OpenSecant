/**
 * Helpers for "Click on Nth link with text …" steps.
 */

/**
 * @param {string} step
 * @returns {{ ordinal: number, index: number, text: string }|null}
 */
function parseOrdinalLinkStep(step) {
  const cleaned = (step || '').replace(/^\d+\.\s*/, '').trim();
  const match = cleaned.match(
    /^click (?:on )?(?:the )?(\d+)(?:st|nd|rd|th) link with text (.+)$/i,
  );
  if (!match) return null;

  const ordinal = parseInt(match[1], 10);
  const text = match[2].trim().replace(/^["'](.+)["']$/, '$1');
  return {
    ordinal,
    index: Math.max(0, ordinal - 1),
    text,
  };
}

/**
 * Playwright locators for "Nth link with text X" using scoped .nth(index).
 * @param {number} ordinal — 1-based
 * @param {string} linkText
 * @returns {string[]}
 */
function buildOrdinalLinkLocatorFallbacks(ordinal, linkText) {
  const index = Math.max(0, ordinal - 1);
  const reBody = (linkText || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  const re = `/${reBody}/i`;

  // Google Shopping / grids often use role="button" overlays, not <a> links
  return [
    `await page.getByRole('button', { name: ${re} }).nth(${index}).click();`,
    `await page.locator('[role="button"]').filter({ hasText: ${re} }).nth(${index}).click();`,
    `await page.getByRole('link').filter({ hasText: ${re} }).nth(${index}).click();`,
    `await page.locator('a').filter({ hasText: ${re} }).nth(${index}).click();`,
    `await page.getByText(${re}).nth(${index}).click();`,
  ];
}

/**
 * True when code uses .nth(N) or .first() with the index required by the step.
 * @param {string} step
 * @param {string} code
 * @returns {boolean}
 */
function ordinalLocatorIndexMatches(step, code) {
  const ord = parseOrdinalLinkStep(step);
  if (!ord || !code) return false;

  const nthMatch = code.match(/\.nth\((\d+)\)/);
  if (nthMatch) {
    return parseInt(nthMatch[1], 10) === ord.index;
  }
  if (/\.first\(\)/.test(code)) {
    return ord.index === 0;
  }
  return false;
}

/**
 * Whether cached/generated code is acceptable for an ordinal link step.
 * @param {string} step
 * @param {string|null} code
 * @returns {boolean}
 */
function isOrdinalLinkStepCodeValid(step, code) {
  const ord = parseOrdinalLinkStep(step);
  if (!ord) return true;
  if (!code || typeof code !== 'string') return false;

  if (ordinalLocatorIndexMatches(step, code)) return true;

  // Element-specific (href / testid / id) without wrong positional index
  if (/\.(?:first|nth|last)\(\)/.test(code)) {
    return ordinalLocatorIndexMatches(step, code);
  }

  return true;
}

module.exports = {
  parseOrdinalLinkStep,
  buildOrdinalLinkLocatorFallbacks,
  ordinalLocatorIndexMatches,
  isOrdinalLinkStepCodeValid,
};
