/**
 * CLI: site exploration, QA agent, and comprehensive QA modes.
 */
const fs = require('fs');
const logger = require('../utils/logger');
const { runComprehensiveQA, runAgent } = require('../engines/agent/qaAgent');
const { exploreSite } = require('../engines/agent/siteExplorer');
const { runFlows } = require('../engines/agent/flowRunner');
const { generateExplorationReport, saveManifest } = require('../engines/agent/testGenerator');

async function runComprehensiveQAMode(promptFile) {
  const promptText = fs.readFileSync(promptFile, 'utf8');
  const result = await runComprehensiveQA(promptText);
  if (result.reportPath) {
    logger.info(`\nComprehensive QA report: ${result.reportPath}`);
  }
  return result.success ? 0 : 1;
}

async function runExploreMode(argv) {
  const exploreIdx = argv.indexOf('--explore');
  let siteUrl = argv[exploreIdx + 1];
  if (!siteUrl || siteUrl.startsWith('--')) {
    throw new Error('Usage: --explore "<url>" [--explore-name <name>]');
  }
  siteUrl = siteUrl.replace(/^explore\s+/i, '');

  const nameIdx = argv.indexOf('--explore-name');
  const exploreName = (nameIdx !== -1 && argv[nameIdx + 1]) ? argv[nameIdx + 1] : 'explore';
  const pagesIdx = argv.indexOf('--explore-max-pages');
  const maxPages = (pagesIdx !== -1 && argv[pagesIdx + 1]) ? parseInt(argv[pagesIdx + 1], 10) : 20;
  const stepsIdx = argv.indexOf('--explore-max-steps');
  const maxStepsPerFlow = (stepsIdx !== -1 && argv[stepsIdx + 1]) ? parseInt(argv[stepsIdx + 1], 10) : 30;

  const manifest = await exploreSite(siteUrl, { maxPages });
  const manifestPath = saveManifest(manifest, exploreName);
  logger.info(`Manifest saved: ${manifestPath}`);

  if (manifest.flows.length === 0) {
    logger.warning('No testable flows discovered.');
    return 1;
  }

  const flowResults = await runFlows(manifest, { maxStepsPerFlow, exploreName });
  const reportPath = generateExplorationReport(manifest, flowResults, { exploreName });
  logger.info(`Exploration report: ${reportPath}`);
  return flowResults.success ? 0 : 1;
}

async function runAgentMode(argv) {
  const agentIdx = argv.indexOf('--agent');
  const goal = argv[agentIdx + 1];
  if (!goal || goal.startsWith('--')) {
    throw new Error('Usage: --agent "<goal>" [--agent-name <name>]');
  }

  const nameIdx = argv.indexOf('--agent-name');
  const baseName = (nameIdx !== -1 && argv[nameIdx + 1]) ? argv[nameIdx + 1] : 'agent-test';
  const maxIdx = argv.indexOf('--agent-max-steps');
  const maxSteps = (maxIdx !== -1 && argv[maxIdx + 1]) ? parseInt(argv[maxIdx + 1], 10) : 50;
  const flowsIdx = argv.indexOf('--agent-max-flows');
  const maxFlows = (flowsIdx !== -1 && argv[flowsIdx + 1]) ? parseInt(argv[flowsIdx + 1], 10) : 1;

  const isExplore = /^explore\b/i.test(goal.trim()) || maxFlows > 1;
  const totalPasses = isExplore ? (flowsIdx !== -1 ? maxFlows : 5) : 1;

  let anySuccess = false;
  const previousPaths = [];

  for (let pass = 1; pass <= totalPasses; pass++) {
    const testName = totalPasses > 1
      ? `${baseName}${String(pass).padStart(2, '0')}`
      : baseName;

    const result = await runAgent(goal, { testName, maxSteps, previousPaths });
    if (result.success) anySuccess = true;
    if (result.testFilePath) logger.info(`Generated test: ${result.testFilePath}`);

    const passedSteps = (result.steps || []).filter((s) => s.success).map((s) => s.step);
    if (passedSteps.length > 0) {
      previousPaths.push(passedSteps.slice(0, 10).join(' → '));
    }
  }

  return anySuccess ? 0 : 1;
}

async function handleExploreCommands(argv) {
  const comprehensiveIdx = argv.indexOf('--comprehensive-qa');
  if (comprehensiveIdx !== -1) {
    const promptFile = argv[comprehensiveIdx + 1];
    if (!promptFile || promptFile.startsWith('--')) {
      throw new Error('Usage: --comprehensive-qa "<prompt-file.txt>"');
    }
    return runComprehensiveQAMode(promptFile);
  }

  if (argv.includes('--explore')) {
    return runExploreMode(argv);
  }

  if (argv.includes('--agent')) {
    return runAgentMode(argv);
  }

  return null;
}

module.exports = {
  handleExploreCommands,
  runComprehensiveQAMode,
  runExploreMode,
  runAgentMode,
};
