/**
 * Parallel test executor module - Functions for running tests in parallel
 */
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const logger = require('../utils/logger');
const report = require('../reporting/htmlReporter');
const env = require('../config/envConfig');

function getCliSummary() {
  return process.argv.slice(2).join(' ') || '(opensecant — default batch)';
}

/**
 * Max parallel workers from testConfig / OPENSECANT_NUM_WORKERS.
 * @returns {number}
 */
function getConfiguredMaxWorkers() {
  const configured = env.testConfig?.numWorkers;
  if (typeof configured === 'number' && configured > 0) {
    return configured;
  }
  return Math.max(1, os.cpus().length - 1);
}

/**
 * Decide sequential vs parallel execution for a batch of tests.
 * @param {number} testCount
 * @param {{ explicitParallel?: boolean, explicitWorkers?: number }} options
 * @returns {{ parallel: boolean, maxWorkers: number }}
 */
function resolveExecutionPlan(testCount, options = {}) {
  const { explicitParallel = false, explicitWorkers } = options;

  if (testCount <= 1) {
    return { parallel: false, maxWorkers: 1 };
  }

  const maxWorkers = explicitWorkers ?? getConfiguredMaxWorkers();
  const cappedWorkers = Math.min(maxWorkers, testCount);

  if (cappedWorkers <= 1 && !explicitParallel) {
    return { parallel: false, maxWorkers: 1 };
  }

  const parallel = explicitParallel || testCount > 1;
  if (!parallel || cappedWorkers <= 1) {
    return { parallel: false, maxWorkers: 1 };
  }

  return { parallel: true, maxWorkers: cappedWorkers };
}

/**
 * Run tests in parallel using worker threads
 * @param {Array} testCaseNames - Array of test case file names or paths
 * @param {number} [maxWorkers] - Maximum parallel workers (defaults to testConfig.numWorkers)
 * @returns {Promise<Array>} Array of test results
 */
async function runTestsInParallel(testCaseNames, maxWorkers = getConfiguredMaxWorkers()) {
  const workerCount = Math.min(maxWorkers, testCaseNames.length);
  logger.info(`Running ${testCaseNames.length} tests with ${workerCount} parallel workers`);

  const { runDir, screenshotsDir } = report.createRunDirectory();
  logger.info(`Reports will be saved to: ${runDir}`);

  const testQueue = [...testCaseNames];
  const activeWorkers = new Map();
  const results = [];

  const createWorker = (testCaseName) => {
    const workerPath = path.join(__dirname, 'testWorker.js');
    const worker = new Worker(workerPath, {
      workerData: {
        testCaseName,
        runDir,
        screenshotsDir,
      },
    });

    activeWorkers.set(worker, testCaseName);

    worker.on('message', (result) => {
      results.push(result);
      logger.info(`Test completed: ${result.testName} (${results.length}/${testCaseNames.length})`);
    });

    worker.on('exit', (code) => {
      activeWorkers.delete(worker);

      const spinNextWorker = () => {
        if (testQueue.length > 0) {
          createWorker(testQueue.shift());
        } else if (activeWorkers.size === 0) {
          // Allow worker `message` handlers to run before assembling the summary (exit can race ahead).
          setImmediate(() => {
            const sorted = results
              .slice()
              .sort((a, b) => String(a.testFile || a.testName || '').localeCompare(String(b.testFile || b.testName || '')));
            report.createIndexReport(runDir, sorted, getCliSummary(), {
              parallel: true,
              maxWorkers: workerCount,
            });
          });
        }
      };

      if (testQueue.length > 0) {
        createWorker(testQueue.shift());
      } else if (activeWorkers.size === 0) {
        spinNextWorker();
      }

      if (code !== 0) {
        logger.error(`Worker for test ${testCaseName} exited with code ${code}`);
      }
    });

    worker.on('error', (error) => {
      logger.error(`Worker error for test ${testCaseName}: ${error.message}`);
      results.push({
        success: false,
        testName: path.basename(testCaseName, '.test'),
        testFile: testCaseName,
        error: error.message,
      });
    });
  };

  const initialWorkerCount = Math.min(workerCount, testQueue.length);
  for (let i = 0; i < initialWorkerCount; i++) {
    createWorker(testQueue.shift());
  }

  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (activeWorkers.size === 0 && testQueue.length === 0) {
        clearInterval(checkInterval);
        resolve(results);
      }
    }, 250);
  });
}

module.exports = {
  runTestsInParallel,
  getConfiguredMaxWorkers,
  resolveExecutionPlan,
};
