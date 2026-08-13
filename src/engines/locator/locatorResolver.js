/**
 * Action Library v3 — deterministic Playwright code generation.
 *
 * Matches plain-English steps to page elements using locatorEngine (DOM + a11y snapshot).
 * Locator priority follows Playwright best practices: role+name → label → placeholder → test id.
 */

const logger = require('../../utils/logger');
const { normalizeNavigationUrl } = require('../../utils/urlUtils');
const locator = require('./localEngine');

const {
  normalizeStep,
  extractWords,
  biOverlap,
  esc,
  getTestId,
  isInputField,
  isClickable,
  isSelectField,
  isCheckbox,
  rankElementsForTarget,
  candidatesFromRanked,
  toCodeList,
  elementSearchText,
  generateOrdinalLinkCandidates,
} = locator;

// ────────────────────────────────────────────────────────────────────────────
// ACTION DEFINITIONS
// ────────────────────────────────────────────────────────────────────────────

const ACTION_LIBRARY = {

  navigate: {
    patterns: [
      /^navigate to (.+)$/i,
      /^go to (.+)$/i,
      /^open (.+)$/i,
      /^visit (.+)$/i,
    ],
    generateCode: (match) => {
      const url = normalizeNavigationUrl(match[1].trim());
      return [`await page.goto('${esc(url)}', { waitUntil: 'domcontentloaded' });`];
    },
  },

  dismiss: {
    patterns: [
      /^close (?:the )?(.+?)(?:\s+if .+)?$/i,
      /^dismiss (?:the )?(.+?)(?:\s+if .+)?$/i,
      /^(?:close|dismiss|hide|cancel) (?:the )?(.+?)(?:\s+(?:dialog|modal|popup|banner|overlay|notification))(?:\s+if .+)?$/i,
    ],
    generateCode: (match, elements) => {
      const target = match[1].trim()
        .replace(/\s+(dialog|dialong|modal|popup|banner|overlay|notification|window|box)$/i, '')
        .trim();
      const candidates = [];

      const ranked = rankElementsForTarget(target, elements, 'dismiss', { minMatch: 0.35 });
      const fromRanked = candidatesFromRanked(
        ranked,
        (loc) => `${loc}.first().click({ timeout: 5000 })`,
        { maxCandidates: 8, tryCatch: true },
      );
      candidates.push(...fromRanked);

      for (const el of (elements || []).filter(isClickable)) {
        const text = (el.text || '').trim();
        const aria = (el.attributes?.['aria-label'] || '');
        const testId = getTestId(el);
        if (/close|dismiss|cancel|no.?thanks/i.test(`${text} ${aria} ${testId || ''}`)) {
          const profile = locator.normalizeElement(el);
          const locs = locator.buildLocatorStrategies(profile, extractWords(target), target);
          for (const loc of locs.slice(0, 2)) {
            candidates.push({
              code: `try { await ${loc.code}.first().click({ timeout: 5000 }); } catch(e) { /* ${target} not present */ }`,
              score: 70 + loc.score,
            });
          }
        }
      }

      const closeSelectors = [
        '[aria-label="Close"]',
        'button.close',
        '.modal-close',
        '[data-dismiss="modal"]',
      ];
      candidates.push({
        code: `try { await page.locator('${closeSelectors.join(', ')}').first().click({ timeout: 5000 }); } catch(e) { /* ${target} not present */ }`,
        score: 40,
      });
      candidates.push({
        code: `try { await page.getByText(/^(Close|Dismiss|No thanks|Cancel)$/i).first().click({ timeout: 5000 }); } catch(e) { /* ${target} not present */ }`,
        score: 35,
      });

      return toCodeList(candidates);
    },
  },

  clickOrdinalLink: {
    patterns: [
      /^click (?:on )?(?:the )?(\d+)(?:st|nd|rd|th) link with text (.+)$/i,
      /^click (?:on )?(?:the )?(\d+)(?:st|nd|rd|th) link (?:that |which )?(?:has|contains|shows) text (.+)$/i,
    ],
    generateCode: (match, elements) => {
      const ordinal = parseInt(match[1], 10);
      const text = match[2].trim().replace(/^["'](.+)["']$/, '$1');
      const codes = generateOrdinalLinkCandidates(ordinal, text, elements || []);
      if (codes.length === 0) return [];
      return codes;
    },
  },

  pressKey: {
    patterns: [
      /^press (enter|escape|tab|space|backspace)(?:\s+(?:in|on|into)\s+(.+))?$/i,
      /^hit (enter|escape|tab|space|backspace)(?:\s+(?:in|on|into)\s+(.+))?$/i,
      /^press the (enter|escape|tab|space|backspace) key(?:\s+(?:in|on|into)\s+(.+))?$/i,
    ],
    generateCode: (match, elements) => {
      const rawKey = (match[1] || 'Enter').toLowerCase();
      const keyMap = {
        enter: 'Enter',
        escape: 'Escape',
        tab: 'Tab',
        space: ' ',
        backspace: 'Backspace',
      };
      const key = keyMap[rawKey] || match[1];
      const field = (match[2] || '').trim();

      if (!field) {
        return [`await page.keyboard.press(${JSON.stringify(key)});`];
      }

      const ranked = rankElementsForTarget(field, elements, 'fill', { minMatch: 0.35 });
      const candidates = candidatesFromRanked(
        ranked,
        (loc) => `${loc}.first().press(${JSON.stringify(key)})`,
        { maxCandidates: 8 },
      );

      if (candidates.length === 0) {
        return [
          `await page.getByLabel('${esc(field)}', { exact: false }).first().press(${JSON.stringify(key)});`,
          `await page.getByPlaceholder('${esc(field)}', { exact: false }).first().press(${JSON.stringify(key)});`,
          `await page.keyboard.press(${JSON.stringify(key)});`,
        ];
      }
      return toCodeList(candidates);
    },
  },

  click: {
    patterns: [
      /^click (?:on |the )?(.+?)(?:\s+button)?$/i,
      // Require "on"/"the" or trailing "button" so "Press Enter" is not treated as a click
      /^press (?:on |the )(.+)$/i,
      /^press (.+) button$/i,
      /^tap (?:on |the )?(.+?)(?:\s+button)?$/i,
    ],
    generateCode: (match, elements) => {
      const target = match[1].trim();
      const ranked = rankElementsForTarget(target, elements, 'click', { minMatch: 0.48 });
      const candidates = candidatesFromRanked(
        ranked,
        (loc) => `${loc}.first().click()`,
        { maxCandidates: 10 },
      );

      if (candidates.length === 0) {
        return [`await page.getByText('${esc(target)}', { exact: false }).first().click();`];
      }
      return toCodeList(candidates);
    },
  },

  check: {
    patterns: [
      /^check (?:the )?(.+?)(?:\s+check\s*box)?$/i,
      /^tick (?:the )?(.+?)(?:\s+check\s*box)?$/i,
      /^enable (?:the )?(.+?)(?:\s+check\s*box)?$/i,
      /^uncheck (?:the )?(.+?)(?:\s+check\s*box)?$/i,
      /^untick (?:the )?(.+?)(?:\s+check\s*box)?$/i,
      /^disable (?:the )?(.+?)(?:\s+check\s*box)?$/i,
    ],
    generateCode: (match, elements) => {
      const isUncheck = /^(uncheck|untick|disable)/i.test(match[0]);
      const action = isUncheck ? 'uncheck' : 'check';
      const target = match[1].trim();

      const checkboxEls = (elements || []).filter(isCheckbox);
      const ranked = rankElementsForTarget(target, checkboxEls.length ? checkboxEls : elements, 'check', {
        minMatch: 0.35,
      });

      const candidates = candidatesFromRanked(
        ranked,
        (loc) => `${loc}.first().${action}()`,
        { maxCandidates: 8 },
      );

      if (candidates.length === 0) {
        return [`await page.getByLabel('${esc(target)}', { exact: false }).first().${action}();`];
      }
      return toCodeList(candidates);
    },
  },

  fill: {
    patterns: [
      /^fill (?:the )?(.+?) (?:as|with) (.+)$/i,
      /^enter (.+?) (?:in ?to|in|to) (?:the )?(.+)$/i,
      /^type (.+?) (?:in ?to|in|to) (?:the )?(.+)$/i,
      /^input (.+?) (?:in ?to|in|to) (?:the )?(.+)$/i,
      /^set (?:the )?(.+?) (?:as|to) (.+)$/i,
    ],
    generateCode: (match, elements) => {
      let fieldName;
      let value;

      if (/^(fill|set)/i.test(match[0])) {
        fieldName = match[1].trim();
        value = match[2].trim();
      } else {
        value = match[1].trim();
        fieldName = match[2].trim();
      }
      value = value.replace(/^["'](.+)["']$/, '$1');

      const ranked = rankElementsForTarget(fieldName, elements, 'fill', { minMatch: 0.42 });
      const candidates = [];

      for (const { locators } of ranked) {
        for (const loc of locators.slice(0, 3)) {
          candidates.push({
            code: `await ${loc.code}.first().fill('${esc(value)}');`,
            score: loc.score,
          });
        }
      }

      if (candidates.length === 0) {
        candidates.push({
          code: `await page.getByPlaceholder('${esc(fieldName)}', { exact: false }).first().fill('${esc(value)}');`,
          score: 30,
        });
        candidates.push({
          code: `await page.getByLabel('${esc(fieldName)}', { exact: false }).first().fill('${esc(value)}');`,
          score: 28,
        });
      }

      return toCodeList(candidates);
    },
  },

  select: {
    patterns: [
      /^select (.+?) (?:from|in) (?:the )?(.+)$/i,
      /^select (.+?) as (.+)$/i,
      /^choose (.+?) (?:from|in) (?:the )?(.+)$/i,
      /^pick (.+?) (?:from|in) (?:the )?(.+)$/i,
    ],
    generateCode: (match, elements) => {
      const part1 = match[1].trim();
      const part2 = match[2].trim();
      const candidates = [];

      const interpretations = [
        { field: part1, value: part2 },
        { field: part2, value: part1 },
      ];

      for (const { field, value } of interpretations) {
        const valueWords = extractWords(value);

        const selectRanked = rankElementsForTarget(field, elements, 'fill', { minMatch: 0.4 });
        for (const { locators } of selectRanked.filter((r) => isSelectField(r.profile.el))) {
          for (const loc of locators.slice(0, 2)) {
            candidates.push({
              code: `await ${loc.code}.first().selectOption('${esc(value)}');`,
              score: loc.score + 5,
            });
          }
        }

        const optionRanked = rankElementsForTarget(value, elements, 'click', { minMatch: 0.45 });
        for (const { locators } of optionRanked) {
          for (const loc of locators.slice(0, 2)) {
            candidates.push({
              code: `await ${loc.code}.first().click();`,
              score: loc.score,
            });
          }
        }

        for (const el of (elements || []).filter(isClickable)) {
          const overlap = biOverlap(valueWords, extractWords(elementSearchText(el)));
          if (overlap < 0.5) continue;
          const profile = locator.normalizeElement(el);
          const locs = locator.buildLocatorStrategies(profile, valueWords, value);
          for (const loc of locs.slice(0, 1)) {
            candidates.push({
              code: `await ${loc.code}.first().click();`,
              score: loc.score,
            });
          }
        }
      }

      return toCodeList(candidates);
    },
  },

  hardWait: {
    patterns: [
      /^wait(?:\s+for)?\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|milliseconds?|ms)$/i,
      /^pause(?:\s+for)?\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|milliseconds?|ms)$/i,
      /^delay(?:\s+for)?\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|milliseconds?|ms)$/i,
    ],
    generateCode: (match) => {
      const amount = parseInt(match[1], 10);
      const unit = (match[2] || 's').toLowerCase();
      let ms;
      if (unit.startsWith('ms') || unit.startsWith('millisecond')) {
        ms = amount;
      } else if (unit.startsWith('m') && !unit.startsWith('ms') && !unit.startsWith('millisecond')) {
        ms = amount * 60000;
      } else {
        ms = amount * 1000;
      }
      return [`await page.waitForTimeout(${ms});`];
    },
  },

  wait: {
    patterns: [
      /^wait(?:\s+for)?(?:\s+(?:the\s+)?page\s+to\s+load)?$/i,
      /^wait for (?:page )?load(?:ing)?$/i,
    ],
    generateCode: (match, elements) => {
      const candidates = [];
      const testIdEls = (elements || []).filter((el) => getTestId(el));
      if (testIdEls.length > 0) {
        const testId = getTestId(testIdEls[0]);
        candidates.push({
          code: `await page.getByTestId('${esc(testId)}').first().waitFor({ state: 'visible', timeout: 30000 });`,
          score: 90,
        });
      }
      candidates.push(
        { code: `await page.waitForLoadState('domcontentloaded');`, score: 80 },
        { code: `await page.waitForLoadState('networkidle', { timeout: 15000 });`, score: 70 },
      );
      return toCodeList(candidates);
    },
  },

  validate: {
    patterns: [
      /^(?:validate|verify|check|assert)\s+text\s+displayed\s+["'](.+?)["']\s*$/i,
      /^(?:validate|verify|check|assert) (?:that )?(.+?) (?:is |are )?(?:displayed|visible|shown|present)$/i,
      /^(?:the )?(.+?) should be (?:displayed|visible|shown|present)$/i,
      /^(?:validate|verify|check|assert) (?:that )?(.+?) (?:message )?(?:is |are )?(?:displayed|visible|shown|present)$/i,
    ],
    generateCode: (match, elements) => {
      const target = match[1].trim();

      // "Verify text displayed \"These are results...\"" — quoted copy in group 1
      if (/text\s+displayed\s+["']/i.test(match[0] || '')) {
        const text = target;
        const candidates = [
          {
            code: `await expect(page.getByText(${JSON.stringify(text)}, { exact: false })).toBeVisible();`,
            score: 90,
          },
          {
            code: `await expect(page.getByText(${JSON.stringify(text)})).toBeVisible();`,
            score: 85,
          },
          {
            code: `await expect(page.locator('body')).toContainText(${JSON.stringify(text)});`,
            score: 80,
          },
        ];
        const ranked = rankElementsForTarget(text, elements, 'assert', { minMatch: 0.35 });
        for (const { locators } of ranked) {
          for (const loc of locators.slice(0, 2)) {
            candidates.push({
              code: `await expect(${loc.code}).toContainText(${JSON.stringify(text)});`,
              score: loc.score + 12,
            });
          }
        }
        return toCodeList(candidates);
      }
      const descriptors = /\s+(message|text|content|error|label|notification|banner|alert)s?$/i;
      const coreTarget = target.replace(descriptors, '').trim();
      const candidates = [];

      const ranked = rankElementsForTarget(target, elements, 'assert', { minMatch: 0.38 });
      for (const { locators } of ranked) {
        for (const loc of locators.slice(0, 2)) {
          candidates.push({
            code: `await expect(${loc.code}.first()).toBeVisible();`,
            score: loc.score + 10,
          });
        }
      }

      candidates.push({
        code: `await expect(page.getByText('${esc(coreTarget)}', { exact: false }).first()).toBeVisible();`,
        score: 75,
      });
      if (coreTarget !== target) {
        candidates.push({
          code: `await expect(page.getByText('${esc(target)}', { exact: false }).first()).toBeVisible();`,
          score: 70,
        });
      }

      return toCodeList(candidates);
    },
  },
};

// ────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Try to generate Playwright code using the action library.
 * @param {string} step - Plain-English test step (may include #N suffix)
 * @param {Array} elements - Hybrid DOM + accessibility elements from pageDataCapture
 * @returns {string[]|null} Candidate code snippets sorted by confidence, or null
 */
function tryActionLibrary(step, elements) {
  const cleaned = normalizeStep(step);
  const elementCount = (elements || []).length;

  for (const [actionType, action] of Object.entries(ACTION_LIBRARY)) {
    for (const pattern of action.patterns) {
      const matchLower = cleaned.toLowerCase().match(pattern);
      if (!matchLower) continue;

      const matchOriginal = cleaned.match(new RegExp(pattern.source, pattern.flags || 'i'));
      const match = matchOriginal || matchLower;

      logger.info(`Action library matched: ${actionType} for "${cleaned}" (${elementCount} elements)`);
      try {
        const results = action.generateCode(match, elements || [], step);
        if (Array.isArray(results) && results.length > 0) {
          if (process.env.OPENSECANT_VERBOSE === 'true') {
            logger.info(`Action library: ${results.length} locator candidate(s) for ${actionType}`);
          }
          return results;
        }
        if (typeof results === 'string') return [results];
      } catch (err) {
        logger.warning(`Action library error (${actionType}): ${err.message}`);
      }
    }
  }

  return null;
}

/**
 * Get action type for a step (for logging).
 */
function getActionType(step) {
  const cleaned = normalizeStep(step).toLowerCase();
  for (const [type, action] of Object.entries(ACTION_LIBRARY)) {
    for (const pattern of action.patterns) {
      if (cleaned.match(pattern)) return type;
    }
  }
  return 'unknown';
}

/**
 * Debug: rank elements for a target without generating full action code.
 */
function debugRankTarget(target, elements, intent = 'click') {
  return rankElementsForTarget(target, elements, intent).map((r) => ({
    matchScore: r.matchScore,
    role: r.profile.role,
    name: r.profile.name,
    testId: r.profile.testId,
    topLocator: r.locators[0]?.description,
    score: r.locators[0]?.score,
  }));
}

module.exports = {
  tryActionLibrary,
  getActionType,
  debugRankTarget,
  ACTION_LIBRARY,
  // Re-export locator engine for tests and elementFiltering
  locator,
};
