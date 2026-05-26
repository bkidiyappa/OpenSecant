/**
 * CLI: healing configuration helpers.
 */
const env = require('../config/envConfig');

function isHealingEnabled() {
  return env.testConfig?.aiHealingEnabled !== false;
}

function printHealingStatus() {
  const enabled = isHealingEnabled();
  console.log(`AI healing: ${enabled ? 'enabled' : 'disabled'}`);
  console.log('Set AI_HEALING_ENABLED=true|false to override.');
}

module.exports = {
  isHealingEnabled,
  printHealingStatus,
};
