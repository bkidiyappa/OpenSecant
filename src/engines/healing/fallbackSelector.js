/**
 * LLM-based fallback selector suggestions when deterministic locators fail.
 */
const { suggestAlternativeLocators } = require('../locator/llmEngine');

module.exports = {
  suggestAlternativeLocators,
};
