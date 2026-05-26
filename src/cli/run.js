/**
 * CLI: run tests
 */
const runner = require('../runner');

async function run(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    runner.showHelp();
    return 0;
  }
  return runner.main();
}

module.exports = { run };
