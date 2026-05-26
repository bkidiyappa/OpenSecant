/**
 * Locator cache — aliases step store for persisted selector mappings.
 */
const { getStepStore } = require('./stepStore');

function getLocatorStore() {
  return getStepStore();
}

module.exports = {
  getLocatorStore,
};
