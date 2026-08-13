/**
 * OpenSecant CLI entry — routes subcommands and flags.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { run } = require('./run');
const { handleExploreCommands } = require('./explore');
const { handleRecordCommand } = require('./record');
const { initProject } = require('./init');
const { printHealingStatus } = require('./heal');

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'init') {
    initProject();
    return 0;
  }

  if (argv.includes('--healing-status')) {
    printHealingStatus();
    return 0;
  }

  const reportsDir = path.join(__dirname, '..', '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const recordExit = await handleRecordCommand(argv);
  if (recordExit !== null) {
    return recordExit;
  }

  const agentExit = await handleExploreCommands(argv);
  if (agentExit !== null) {
    return agentExit;
  }

  return run(argv);
}

module.exports = { main };
