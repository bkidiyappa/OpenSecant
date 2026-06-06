/**
 * Main runner module - Entry point for test execution
 */
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { runTest, runMultipleTests } = require('./testExecutor');
const { runTestsInParallel, resolveExecutionPlan, getConfiguredMaxWorkers } = require('./parallelExecutor');
const { findTestFiles, getTestFilesByTag, resolveTestPaths } = require('./testReader');
const report = require('../reporting/htmlReporter');
const { getStepStore } = require('../store/stepStore');

/**
 * Display help message
 */
function showHelp() {
  console.log(`
OpenSecant — Natural-language test automation

Usage:
  npx opensecant                     Run all tests
  npx opensecant <test-name>         Run one test (.test optional; finds under tests/)
  npx opensecant --test <name>       Same as above (alias: -t)
  npx opensecant smoke/search        Run by path under tests/
  npm run test:one -- search         npm shortcut for a single test
  npx opensecant --tag <tag-name>    Run tests with the specified tag
  npx opensecant --parallel          Force parallel-aware planning when multiple workers are available
  npx opensecant --parallel <n>      Run with up to n parallel workers
  npx opensecant --env=<env>         Environment: develop, release, preprod, production
  npx opensecant --browser=<name>    chromium, chrome, edge, firefox, webkit
  npx opensecant --help              Show this help

  Add a PAUSE step in a .test file to halt for manual inspection (press Enter to continue).
  See docs/WRITING_TESTS.md#interactive-pause--pause

  Batches with 2+ tests run in parallel when workers > 1 (override with OPENSECANT_NUM_WORKERS).
  Summary wall-clock time is about the longest test, not the sum of each table row.

Agent modes:
  npx opensecant --agent "<goal>" [--agent-name <n>] [--agent-max-steps <n>]
  npx opensecant --explore "<url>" [--explore-name <n>] [--explore-max-pages <n>]
  npx opensecant --comprehensive-qa "<prompt-file>"

See docs/QA_AGENT.md and docs/ARCHITECTURE.md for details.
`);
}

/**
 * Run a batch of tests sequentially or in parallel based on count and config.
 * @param {string[]} testFiles
 * @param {{ runParallel?: boolean, numWorkers?: number }} options
 * @returns {Promise<Array>}
 */
async function executeTests(testFiles, options = {}) {
  const { runParallel = false, numWorkers } = options;
  const plan = resolveExecutionPlan(testFiles.length, {
    explicitParallel: runParallel,
    explicitWorkers: numWorkers,
  });

  if (plan.parallel) {
    logger.info(
      `Running ${testFiles.length} tests in parallel with ${plan.maxWorkers} workers`
    );
    return runTestsInParallel(testFiles, plan.maxWorkers);
  }

  logger.info(`Running ${testFiles.length} test(s) sequentially`);
  return runMultipleTests(testFiles);
}

/**
 * Compute process exit code from test result array.
 * @param {Array<{success?: boolean}>|undefined} results
 * @returns {number}
 */
function getExitCodeFromResults(results) {
  if (!results || !Array.isArray(results) || results.length === 0) {
    return 0;
  }
  return results.some((r) => r && r.success === false) ? 1 : 0;
}

/**
 * Extract test names from --test / -t flags.
 * @param {string[]} args
 * @returns {string[]}
 */
function extractTestFlagSpecs(args) {
  const specs = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--test' || arg === '-t') {
      const val = args[i + 1];
      if (!val || val.startsWith('--')) {
        throw new Error('Usage: --test <name>  (e.g. --test search or --test smoke/search)');
      }
      specs.push(val);
      i++;
    } else if (arg.startsWith('--test=')) {
      const val = arg.slice('--test='.length);
      if (val) specs.push(val);
    }
  }
  return specs;
}

/**
 * Resolve CLI test specifiers and run them.
 * @param {string[]} specs
 * @param {string} testDir
 * @param {{ runParallel?: boolean, numWorkers?: number }} options
 * @returns {Promise<number>}
 */
async function runTestsBySpec(specs, testDir, options = {}) {
  const { paths, errors } = resolveTestPaths(specs, testDir);

  if (errors.length > 0) {
    for (const err of errors) {
      logger.error(err);
    }
    return 1;
  }

  if (paths.length === 0) {
    logger.error('No valid tests to run');
    return 1;
  }

  const plan = resolveExecutionPlan(paths.length, {
    explicitParallel: options.runParallel,
    explicitWorkers: options.numWorkers,
  });
  const modeLabel = plan.parallel
    ? `in parallel with ${plan.maxWorkers} workers`
    : 'sequentially';
  logger.info(`Running ${paths.length} test(s) ${modeLabel}: ${paths.map((p) => path.relative(testDir, p)).join(', ')}`);

  const results = await executeTests(paths, options);
  return getExitCodeFromResults(results);
}

/**
 * Main entry point for the test runner
 * @returns {Promise<number>} Process exit code (0 = pass, 1 = fail)
 */
async function main() {
  try {
    // Initialize step store
    const stepStore = getStepStore();
    const stats = stepStore.getStats();
    logger.info(`Step store: ${stats.steps} steps`);

    // Parse command line arguments
    const args = process.argv.slice(2);
    const testDir = path.join(__dirname, '../../tests');
    
    // Check for parallel execution flag
    const parallelIndex = args.indexOf('--parallel');
    const runParallel = parallelIndex !== -1;
    
    // Get number of workers if specified
    let numWorkers = undefined;
    if (runParallel && parallelIndex + 1 < args.length && !args[parallelIndex + 1].startsWith('--')) {
      numWorkers = parseInt(args[parallelIndex + 1], 10);
      if (isNaN(numWorkers)) {
        numWorkers = undefined;
      }
    }
    
    const runOptions = { runParallel, numWorkers };
    const testFlagSpecs = extractTestFlagSpecs(args);

    // Filter out command line flags and their values
    const filteredArgs = args.filter((arg, index) => {
      // Skip --parallel flag and its value
      if (arg === '--parallel') return false;
      if (index > 0 && args[index - 1] === '--parallel' && !arg.startsWith('--')) return false;

      // Skip --test / -t and value
      if (arg === '--test' || arg === '-t') return false;
      if (index > 0 && (args[index - 1] === '--test' || args[index - 1] === '-t') && !arg.startsWith('--')) {
        return false;
      }
      if (arg.startsWith('--test=')) return false;
      
      // Skip --env flag and its value
      if (arg === '--env') return false;
      if (index > 0 && args[index - 1] === '--env' && !arg.startsWith('--')) return false;
      
      // Skip --env=value format
      if (arg.startsWith('--env=')) return false;

      // Skip --browser flag and its value
      if (arg === '--browser') return false;
      if (index > 0 && args[index - 1] === '--browser' && !arg.startsWith('--')) return false;
      if (arg.startsWith('--browser=')) return false;
      
      return true;
    });

    if (testFlagSpecs.length > 0) {
      return runTestsBySpec(testFlagSpecs, testDir, runOptions);
    }
    
    if (filteredArgs.length === 0) {
      logger.info('No test specified. Running all tests...');
      const testFiles = findTestFiles(testDir);
      
      const results = await executeTests(testFiles, { runParallel, numWorkers });
      return getExitCodeFromResults(results);
    } else if (filteredArgs[0] === '--help') {
      showHelp();
      return 0;
    } else if (filteredArgs[0] === '--tag' && filteredArgs[1]) {
      try {
        const tagName = filteredArgs[1];
        logger.info(`Running tests with tag: ${tagName}`);
        
        // Special handling for smoke tag
        if (tagName.toLowerCase() === 'smoke') {
          const smokeDir = path.join(__dirname, '../../tests/smoke');
          logger.info(`Looking for smoke tests in directory: ${smokeDir}`);
          
          if (fs.existsSync(smokeDir)) {
            const smokeTests = fs.readdirSync(smokeDir)
              .filter(file => file.endsWith('.test'))
              .map(file => path.join('smoke', file));
            
            logger.info(`Found ${smokeTests.length} smoke tests directly in smoke directory`);
            
            if (smokeTests.length === 0) {
              logger.error(`No smoke tests found in ${smokeDir}`);
              process.exit(1);
            }
            
            const results = await executeTests(smokeTests, { runParallel, numWorkers });
            return getExitCodeFromResults(results);
          } else {
            logger.warning(`Smoke directory not found: ${smokeDir}`);
            logger.info('Falling back to tag search...');
          }
        }
        
        // Regular tag search
        const testFiles = getTestFilesByTag(tagName);
        
        if (testFiles.length === 0) {
          logger.error(`No tests found with tag: ${tagName}`);
          process.exit(1);
        }
        
        const results = await executeTests(testFiles, { runParallel, numWorkers });
        return getExitCodeFromResults(results);
      } catch (error) {
        logger.error(`Error processing tag search: ${error.message}`);
        logger.error(error.stack);
        return 1;
      }
    } else {
      return runTestsBySpec(filteredArgs, testDir, runOptions);
    }

    return 0;
  } catch (error) {
    logger.error('Error running tests:', error);
    return 1;
  }
}

module.exports = {
  main,
  showHelp,
  getExitCodeFromResults,
  executeTests,
};
