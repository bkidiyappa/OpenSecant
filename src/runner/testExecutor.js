/**
 * Test executor module - Functions for running tests
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const report = require('../reporting/htmlReporter');
const { executeStep } = require('./stepExecutor');
const { preprocessSteps } = require('./stepPreprocessor');
const optimizer = require('./performanceOptimizer');
const { launchBrowser, getDefaultContextOptions, newPage } = require('./browserLauncher');
const { resetConversationSession } = require('../engines/locator/llmEngine');

/**
 * Run a single test
 * @param {string} testCaseName - Name of the test case file
 * @param {string} runDir - Directory for test run artifacts
 * @param {string} screenshotsDir - Directory for screenshots
 * @returns {Promise<Object>} Test results
 */
async function runTest(testCaseName, runDir, screenshotsDir) {
  const testCasePath = path.isAbsolute(testCaseName)
    ? testCaseName 
    : path.join(__dirname, '../../tests', testCaseName);
  
  const { readTestCase } = require('./testReader');
  const testCase = optimizer.getCachedTestCase(testCasePath, readTestCase);
  const testNameWithoutExtension = path.basename(testCaseName, '.test');
  
  logger.info(`Running test: ${testCase.testName}`);
  logger.info(`Test file: ${testCasePath}`);
  
  // LLM provider is lazy-initialized on first use (inside suggestAlternativeLocators)
  // No eager initialization needed here
  
  // Create HTML report file
  const reportFilePath = path.join(runDir, `${testNameWithoutExtension}.html`);
  const reportStream = fs.createWriteStream(reportFilePath);
  
  const startTime = new Date();
  let endTime = new Date();
  let durationSeconds = 0;

  const headerHtml = report.createHtmlReportHeader(
    testCase.testName,
    report.formatDateTimeIST(startTime)
  );
  reportStream.write(headerHtml);
  
  // Launch browser
  const browser = await launchBrowser();
  const context = await browser.newContext(getDefaultContextOptions());
  
  const page = await newPage(context);
  
  let allStepsPassed = true;
  const stepResults = [];
  let totalSteps = 0;
  let passedSteps = 0;
  let failedSteps = 0;
  
  try {
    // ── Preprocess steps: expand @reuse, substitute {{env}}/{{keyword}} ──
    const processedSteps = preprocessSteps(testCase.steps);
    logger.info(`Preprocessed ${testCase.steps.length} raw steps → ${processedSteps.length} executable steps`);

    const totalProcessed = processedSteps.length;

    stepsLoop: for (let stepIdx = 0; stepIdx < totalProcessed; stepIdx++) {
      const processed = processedSteps[stepIdx];
      const isLastStep = stepIdx === totalProcessed - 1;
      totalSteps++;

      // Show reuse source in logs
      const sourceTag = processed.isReuse ? ` [from ${processed.source}]` : '';
      const displayOriginal = processed.original.replace(/^\d+\.\s*/, '').trim();
      const displayResolved = processed.resolved;

      // Log both original and resolved if different
      if (displayOriginal !== displayResolved) {
        logger.info(`Executing step: ${displayResolved}  (original: ${displayOriginal})${sourceTag}`);
      } else {
        logger.info(`Executing step: ${displayResolved}${sourceTag}`);
      }

      // Handle @reuse expansion failure
      if (processed.reuseFailed) {
        const stepT0 = Date.now();
        const stepTiming = {
          startTime: new Date(stepT0),
          durationMs: Date.now() - stepT0,
        };
        const stepHtml = report.addStepToHtmlReport(
          displayOriginal,
          'FAIL',
          'Reused test file not found or empty',
          null,
          null,
          stepTiming
        );
        reportStream.write(stepHtml);
        failedSteps++;
        allStepsPassed = false;
        stepResults.push({ step: displayOriginal, success: false, message: 'Reused test file not found or empty', screenshot: null });
        continue;
      }

      const stepSlug = displayResolved.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
      
      const stepT0 = Date.now();
      // executeStep uses the RESOLVED text (with actual values)
      const stepResult = await executeStep(page, displayResolved, runDir);
      
      if (stepResult.success) {
        let stepDetails = 'Step passed';
        if (stepResult.interactivePause) {
          stepDetails = stepResult.interactivePauseSkipped
            ? stepResult.message
            : 'Paused for manual inspection; continued after Enter';
        } else if (stepResult.usedAlternative) {
          stepDetails = `Step passed using alternative locator: ${stepResult.alternativeCode}`;
        }
        
        // Capture screenshot on last step
        let screenshotRelPath = null;
        if (isLastStep) {
          const lastStepScreenshot = path.join(screenshotsDir, `${testNameWithoutExtension}_${stepSlug}_last.png`);
          try {
            await page.screenshot({ path: lastStepScreenshot, fullPage: false });
            screenshotRelPath = `screenshots/${path.basename(lastStepScreenshot)}`;
            logger.info(`Last step screenshot saved: ${lastStepScreenshot}`);
          } catch (_) { /* page may be closed */ }
        }

        const stepTiming = {
          startTime: new Date(stepT0),
          durationMs: Date.now() - stepT0,
        };

        const stepHtml = report.addStepToHtmlReport(
          displayOriginal,
          'PASS',
          stepDetails,
          screenshotRelPath,
          displayOriginal !== displayResolved ? displayResolved : null,
          stepTiming
        );
        reportStream.write(stepHtml);
        passedSteps++;
      } else {
        const failScreenshot = path.join(screenshotsDir, `${testNameWithoutExtension}_${stepSlug}_fail.png`);
        try {
          await page.screenshot({ path: failScreenshot, fullPage: false });
        } catch (_) { /* page may be closed */ }
        
        const relativeScreenshotPath = `screenshots/${path.basename(failScreenshot)}`;

        const stepTiming = {
          startTime: new Date(stepT0),
          durationMs: Date.now() - stepT0,
        };

        const stepHtml = report.addStepToHtmlReport(
          displayOriginal,
          'FAIL',
          stepResult.error,
          relativeScreenshotPath,
          displayOriginal !== displayResolved ? displayResolved : null,
          stepTiming
        );
        reportStream.write(stepHtml);
        failedSteps++;
        allStepsPassed = false;
        
        if (stepResult.stopTest) {
          logger.error('Stopping test execution due to unrecoverable step failure. Skipping remaining steps.');
          break stepsLoop;
        }
      }
      
      stepResults.push({
        step: displayOriginal,
        resolvedStep: displayResolved,
        success: stepResult.success,
        message: stepResult.success ? stepResult.message : stepResult.error,
        screenshot: stepResult.success ? null : `${testNameWithoutExtension}_${stepSlug}_fail.png`
      });
    }
  } catch (error) {
    const errT0 = Date.now();
    logger.error(`Error running test: ${error.message}`);
    const stepTiming = {
      startTime: new Date(errT0),
      durationMs: Date.now() - errT0,
    };
    const errorHtml = report.addStepToHtmlReport('Test execution', 'FAIL', error.message, null, null, stepTiming);
    reportStream.write(errorHtml);
    failedSteps++;
    allStepsPassed = false;
  } finally {
    await context.close();
    await browser.close();
    
    endTime = new Date();
    durationSeconds = (endTime - startTime) / 1000;
    const footerHtml = report.createHtmlReportFooter(
      allStepsPassed ? 'PASS' : 'FAIL',
      report.formatDateTimeIST(endTime),
      durationSeconds,
      totalSteps,
      passedSteps,
      failedSteps,
      process.argv.slice(2).join(' ')
    );
    reportStream.write(footerHtml);
    reportStream.end();
    
    resetConversationSession();
    logger.info(`Test execution completed. Report saved to: ${reportFilePath}`);
  }
  
  const startTimeFormatted = startTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST';
  const endTimeFormatted = endTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST';
  const durationFormatted = `${durationSeconds.toFixed(2)} seconds`;
  
  return {
    success: allStepsPassed,
    testName: testCase.testName,
    testFile: testCaseName,
    reportPath: reportFilePath,
    startTime: startTimeFormatted,
    endTime: endTimeFormatted,
    duration: durationFormatted,
    steps: stepResults
  };
}

/**
 * Run multiple tests in sequence
 * @param {Array} testCaseNames - Array of test case file names
 * @returns {Promise<Array>} Array of test results
 */
async function runMultipleTests(testCaseNames) {
  const results = [];
  // Use the correct function name from the report module
  const { runDir, screenshotsDir } = report.createRunDirectory();
  
  // Screenshots directory is already created by createRunDirectory
  logger.info(`Running ${testCaseNames.length} tests sequentially`);
  logger.info(`Reports will be saved to: ${runDir}`);
  
  for (const testCaseName of testCaseNames) {
    try {
      const result = await runTest(testCaseName, runDir, screenshotsDir);
      results.push(result);
    } catch (error) {
      logger.error(`Error running test ${testCaseName}: ${error.message}`);
      
      // Create formatted timestamps for failed tests too
      const errorTime = new Date();
      const startTimeFormatted = errorTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST';
      const endTimeFormatted = startTimeFormatted; // Same as start time for failed tests
      const durationFormatted = '0.00 seconds';
      
      // Get test name from file path
      const testName = path.basename(testCaseName, '.test');
      
      // Create report path for failed test
      const reportFileName = `${testName}.html`;
      const reportPath = path.join(runDir, reportFileName);
      
      results.push({
        success: false,
        testName: testName,
        testFile: testCaseName,
        reportPath: reportPath,
        startTime: startTimeFormatted,
        endTime: endTimeFormatted,
        duration: durationFormatted,
        error: error.message
      });
    }
  }
  
  // Create index.html with links to all test reports using the correct function name
  report.createIndexReport(
    runDir,
    results,
    process.argv.slice(2).join(' ') || '(opensecant — default batch)',
    { parallel: false, maxWorkers: 1 }
  );
  
  return results;
}

module.exports = {
  runTest,
  runMultipleTests
};
