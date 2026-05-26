/**
 * Element Filtering Module
 * Pre-filters hybrid page data before action library / LLM using shared locator scoring.
 */

const logger = require('../../utils/logger');
const { extractWords, scoreElementRelevance } = require('./localEngine');

/**
 * Filter hybrid data to elements most relevant to the step description.
 * @param {Array} hybridData - Array of element data objects
 * @param {string} stepDescription - The test step description
 * @returns {Array} - Filtered array of relevant elements
 */
function filterRelevantElements(hybridData, stepDescription) {
  if (!hybridData || hybridData.length === 0) return hybridData;

  const keywords = extractWords(stepDescription).filter((kw) => kw.length >= 3);

  const scored = hybridData.map((el) => ({
    ...el,
    relevanceScore: scoreElementRelevance(stepDescription, el),
  }));

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  const seenIds = new Set();
  const seenTestIds = new Set();
  const deduped = scored.filter((el) => {
    const id = el.attributes?.id;
    const testId = el.attributes?.['data-testid'] || el.attributes?.testdataid;
    if (id && seenIds.has(id)) return false;
    if (testId && seenTestIds.has(testId)) return false;
    if (id) seenIds.add(id);
    if (testId) seenTestIds.add(testId);
    return true;
  });

  const minScore = keywords.length > 0 ? 8 : 0;
  const relevant = deduped.filter((el) => el.relevanceScore >= minScore);
  const topElements = (relevant.length > 0 ? relevant : deduped).slice(0, 50);

  if (topElements.length < hybridData.length) {
    logger.info(
      `Element filter: ${topElements.length}/${hybridData.length} elements (keywords: ${keywords.slice(0, 6).join(', ') || 'none'})`,
    );
  }

  return topElements.map((el) => {
    const { relevanceScore, ...rest } = el;
    return rest;
  });
}

/**
 * Update selectors.json file with a working locator
 * @param {string} testCaseName - Name of the test case
 * @param {string} step - Step description
 * @param {string} workingCode - Working Playwright code
 * @returns {boolean} - Success status
 */
async function updateSelectorsJson(testCaseName, step, workingCode) {
  const fs = require('fs');
  const path = require('path');

  try {
    const aiHealingEnabled = process.env.AI_HEALING_ENABLED
      && process.env.AI_HEALING_ENABLED.toLowerCase() === 'true';

    if (!aiHealingEnabled) {
      logger.warning('AI healing is disabled. Skipping selector update.');
      return false;
    }

    logger.info(`Updating selectors.json for test: ${testCaseName}, step: ${step}`);

    const selectorsPath = path.join(__dirname, '../../scripts/selectors.json');
    if (!fs.existsSync(selectorsPath)) {
      logger.error(`Selectors file not found at: ${selectorsPath}`);
      return false;
    }

    let selectors;
    try {
      selectors = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));
    } catch (parseError) {
      logger.error(`Failed to parse selectors.json: ${parseError.message}`);
      return false;
    }

    if (!selectors[testCaseName]) {
      selectors[testCaseName] = {};
    }

    selectors[testCaseName][step] = {
      playwright_code: workingCode,
    };

    fs.writeFileSync(selectorsPath, JSON.stringify(selectors, null, 2), 'utf8');
    logger.info(`Successfully updated selectors.json for step: ${step}`);
    return true;
  } catch (error) {
    logger.error(`Error updating selectors.json: ${error.message}`);
    return false;
  }
}

module.exports = {
  filterRelevantElements,
  updateSelectorsJson,
};
