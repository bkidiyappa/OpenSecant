/**
 * Flow Runner — executes discovered flows using the QA Agent.
 *
 * Takes a flow manifest from the Site Explorer and runs the QA Agent
 * for each discovered flow. The StepStore grows across runs so later
 * flows benefit from earlier discoveries.
 *
 * Usage (internal):
 *   const { runFlows } = require('./flowRunner');
 *   const results = await runFlows(manifest, { maxStepsPerFlow: 30 });
 */

const logger = require('../../utils/logger');
const { runAgent } = require('./qaAgent');
const { getStepStore } = require('../../store/stepStore');

/**
 * Build a natural-language goal from a flow definition.
 *
 * @param {Object} flow - Flow from the manifest
 * @param {string} siteUrl - Site root URL
 * @returns {string} Goal string for runAgent
 */
function buildGoalFromFlow(flow, siteUrl) {
  const parts = [`On ${siteUrl}`];

  // Describe the flow
  if (flow.type === 'multi-step-form' || flow.type === 'form') {
    parts.push(`fill the ${flow.name} form`);
  } else {
    parts.push(`complete the ${flow.name} flow`);
  }

  // Add entry path hints
  if (flow.entryPath && flow.entryPath.length > 0) {
    const entryHints = flow.entryPath.map(e => e.action).join(', then ');
    parts.push(`(start by: ${entryHints})`);
  }

  // Add submit hint
  if (flow.submitText) {
    parts.push(`and click ${flow.submitText} to submit`);
  }

  return parts.join(' ');
}

/**
 * Build a test name from a flow definition.
 */
function buildTestName(flow, exploreName) {
  const base = flow.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  return exploreName ? `${exploreName}-${base}` : base;
}

/**
 * Run all discovered flows sequentially.
 *
 * @param {Object} manifest - Flow manifest from Site Explorer
 * @param {Object} options - { maxStepsPerFlow, exploreName, maxFlows }
 * @returns {Promise<Object>} Results for all flows
 */
async function runFlows(manifest, options = {}) {
  const maxStepsPerFlow = options.maxStepsPerFlow || 50;
  const exploreName = options.exploreName || '';
  const maxFlows = options.maxFlows || 30;

  const flows = manifest.flows.slice(0, maxFlows);

  if (flows.length === 0) {
    logger.warning('[FlowRunner] No flows to execute');
    return { success: false, results: [], error: 'No flows discovered' };
  }

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`FLOW RUNNER STARTED`);
  logger.info(`Site: ${manifest.site}`);
  logger.info(`Flows to execute: ${flows.length}`);
  logger.info(`Max steps per flow: ${maxStepsPerFlow}`);
  logger.info(`${'═'.repeat(60)}\n`);

  const results = [];
  const startTime = Date.now();

  for (let i = 0; i < flows.length; i++) {
    const flow = flows[i];
    const testName = buildTestName(flow, exploreName);
    const goal = buildGoalFromFlow(flow, manifest.site);

    logger.info(`\n${'━'.repeat(60)}`);
    logger.info(`FLOW ${i + 1}/${flows.length}: ${flow.name}`);
    logger.info(`Type: ${flow.type} | Fields: ${flow.fieldCount} | Priority: ${flow.priority}`);
    logger.info(`Goal: ${goal}`);
    logger.info(`Test name: ${testName}`);
    logger.info(`${'━'.repeat(60)}\n`);

    try {
      const result = await runAgent(goal, {
        testName,
        maxSteps: maxStepsPerFlow
      });

      results.push({
        flow,
        testName,
        goal,
        ...result
      });

      const stepStore = getStepStore();
      const stats = stepStore.getStats();
      logger.info(`[FlowRunner] StepStore now has ${stats.steps} cached steps`);

      if (result.goalDone) {
        logger.success(`[FlowRunner] ✅ Flow "${flow.name}" completed successfully`);
      } else if (result.goalStuck) {
        logger.warning(`[FlowRunner] ⚠️ Flow "${flow.name}" got stuck`);
      } else {
        logger.warning(`[FlowRunner] ⚠️ Flow "${flow.name}" hit max steps`);
      }

    } catch (err) {
      logger.error(`[FlowRunner] ❌ Flow "${flow.name}" threw error: ${err.message}`);
      results.push({
        flow,
        testName,
        goal,
        success: false,
        error: err.message
      });
    }
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  const completed = results.filter(r => r.goalDone).length;
  const stuck = results.filter(r => r.goalStuck).length;
  const errored = results.filter(r => r.error && !r.goalStuck).length;

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`FLOW RUNNER FINISHED`);
  logger.info(`Flows: ${completed} completed, ${stuck} stuck, ${errored} errored (${flows.length} total)`);
  logger.info(`Duration: ${durationSeconds.toFixed(1)}s`);
  logger.info(`${'═'.repeat(60)}\n`);

  return {
    success: completed > 0,
    site: manifest.site,
    totalFlows: flows.length,
    completed,
    stuck,
    errored,
    durationSeconds,
    results
  };
}

module.exports = { runFlows, buildGoalFromFlow, buildTestName };
