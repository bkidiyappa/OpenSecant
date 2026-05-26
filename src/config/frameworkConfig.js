/**
 * OpenSecant framework defaults.
 */
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

module.exports = {
  name: 'opensecant',
  version: require('../../package.json').version,
  paths: {
    root: ROOT_DIR,
    tests: path.join(ROOT_DIR, 'tests'),
    data: path.join(ROOT_DIR, 'data'),
    reports: path.join(ROOT_DIR, 'reports'),
    debugPrompts: path.join(ROOT_DIR, 'debug-prompts'),
    stepStore: path.join(ROOT_DIR, 'data', 'stepstore.json'),
  },
  defaults: {
    healRounds: 2,
    maxAgentSteps: 130,
  },
};
