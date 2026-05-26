/**
 * DOM relevance filtering before healing attempts.
 */
const { filterRelevantElements } = require('../locator/elementFiltering');
const { captureHybridInputData } = require('../locator/pageDataCapture');

/**
 * Capture page data and return elements focused on the step description.
 */
async function captureFocusedElements(page, stepDescription) {
  const hybridData = await captureHybridInputData(page, null, stepDescription);
  return filterRelevantElements(hybridData || [], stepDescription) || [];
}

module.exports = {
  filterRelevantElements,
  captureHybridInputData,
  captureFocusedElements,
};
