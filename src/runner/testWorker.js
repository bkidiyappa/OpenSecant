/**
 * Test worker module - Executes a single test in a worker thread
 */
const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const logger = require('../utils/logger');

logger.disableConsoleOverride();

/**
 * Execute a test in a worker thread (delegates to testExecutor.runTest)
 */
async function executeTestInWorker() {
  const { testCaseName, runDir, screenshotsDir } = workerData;

  try {
    const { runTest } = require('./testExecutor');
    const result = await runTest(testCaseName, runDir, screenshotsDir);
    parentPort.postMessage(result);
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    logger.error(`[Worker] Unhandled error: ${error.message}`);
    parentPort.postMessage({
      success: false,
      testName: path.basename(testCaseName, '.test'),
      testFile: testCaseName,
      error: error.message,
    });
    process.exit(1);
  }
}

executeTestInWorker().catch((error) => {
  logger.error(`[Worker] Fatal error: ${error.message}`);
  process.exit(1);
});
