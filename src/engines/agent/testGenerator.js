/**
 * Test Generator — creates .test files and updates stepstore from agent-recorded actions.
 *
 * After the QA Agent finishes exploring a website, this module:
 *   1. Generates a .test file with the recorded steps
 *   2. Updates the stepstore with any new step→code mappings
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const TESTS_DIR = path.join(__dirname, '../../../tests/smoke');

/**
 * Generate a .test file from recorded agent steps.
 *
 * @param {string} testName - Name for the test (used as filename and title)
 * @param {Array} recordedSteps - Array of { step, code, success } from agent run
 * @param {Object} options - Optional: { tags, outputDir }
 * @returns {string} Path to the generated .test file
 */
function generateTestFile(testName, recordedSteps, options = {}) {
  const tags = options.tags || ['@smoke', '@agent-generated'];
  const outputDir = options.outputDir || TESTS_DIR;

  // Sanitize test name for filename
  const safeName = testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const fileName = `${safeName}.test`;
  const filePath = path.join(outputDir, fileName);

  // Build the .test file content
  const lines = [];

  // Tag line
  if (tags.length > 0) {
    lines.push(tags.join(' '));
  }

  // Steps — only include successful steps, deduplicated (keep first occurrence of each unique step)
  const successfulSteps = recordedSteps.filter(s => s.success);
  const seenSteps = new Set();
  for (const { step } of successfulSteps) {
    const normalized = step.toLowerCase().trim();
    if (!seenSteps.has(normalized)) {
      seenSteps.add(normalized);
      lines.push(step);
    }
  }

  const content = lines.join('\n') + '\n';

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(filePath, content, 'utf8');
  logger.info(`[TestGenerator] Test file created: ${filePath} (${successfulSteps.length} steps)`);

  return filePath;
}

/**
 * Generate a summary report of the agent run.
 *
 * @param {string} testName - Test name
 * @param {Array} recordedSteps - All recorded steps
 * @param {Object} meta - { goal, startUrl, durationSeconds, totalLLMCalls }
 * @returns {string} Path to the summary file
 */
function generateAgentReport(testName, recordedSteps, meta = {}) {
  const reportsDir = path.join(__dirname, '../../../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const safeName = testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `agent_${safeName}_${timestamp}.md`);

  const passed = recordedSteps.filter(s => s.success).length;
  const failed = recordedSteps.filter(s => !s.success).length;

  let md = `# QA Agent Report: ${testName}\n\n`;
  md += `- **Goal:** ${meta.goal || 'N/A'}\n`;
  md += `- **Start URL:** ${meta.startUrl || 'N/A'}\n`;
  md += `- **Duration:** ${meta.durationSeconds ? meta.durationSeconds.toFixed(1) + 's' : 'N/A'}\n`;
  md += `- **Steps:** ${passed} passed, ${failed} failed, ${recordedSteps.length} total\n`;
  md += `- **LLM Calls:** ${meta.totalLLMCalls || 0}\n\n`;

  md += `## Steps\n\n`;
  md += `| # | Step | Status | Source | Code |\n`;
  md += `|---|------|--------|--------|------|\n`;

  for (let i = 0; i < recordedSteps.length; i++) {
    const s = recordedSteps[i];
    const status = s.success ? '✅' : '❌';
    const source = s.source || '-';
    const code = s.code ? `\`${s.code.substring(0, 80)}${s.code.length > 80 ? '...' : ''}\`` : '-';
    md += `| ${i + 1} | ${s.step} | ${status} | ${source} | ${code} |\n`;
  }

  if (failed > 0) {
    md += `\n## Failed Steps\n\n`;
    for (const s of recordedSteps.filter(s => !s.success)) {
      md += `- **${s.step}**: ${s.error || 'unknown error'}\n`;
    }
  }

  fs.writeFileSync(reportPath, md, 'utf8');
  logger.info(`[TestGenerator] Agent report saved: ${reportPath}`);
  return reportPath;
}

/**
 * Generate a master exploration report after multi-flow execution.
 *
 * @param {Object} manifest - Site Explorer manifest
 * @param {Object} flowResults - Results from flowRunner.runFlows()
 * @param {Object} options - { exploreName }
 * @returns {string} Path to the exploration report
 */
function generateExplorationReport(manifest, flowResults, options = {}) {
  const reportsDir = path.join(__dirname, '../../../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const exploreName = options.exploreName || 'explore';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `explore_${exploreName}_${timestamp}.md`);

  let md = `# Site Exploration Report: ${manifest.site}\n\n`;
  md += `- **Explored at:** ${manifest.exploredAt}\n`;
  md += `- **Pages visited:** ${manifest.pagesVisited}\n`;
  md += `- **Flows discovered:** ${manifest.flows.length}\n`;
  md += `- **Flows executed:** ${flowResults.totalFlows}\n`;
  md += `- **Completed:** ${flowResults.completed}\n`;
  md += `- **Stuck:** ${flowResults.stuck}\n`;
  md += `- **Errored:** ${flowResults.errored}\n`;
  md += `- **Total duration:** ${flowResults.durationSeconds.toFixed(1)}s\n\n`;

  // Site Map
  md += `## Site Map\n\n`;
  md += `| URL | Type | Forms | Fields | Links |\n`;
  md += `|-----|------|-------|--------|-------|\n`;
  for (const [url, info] of Object.entries(manifest.siteMap)) {
    md += `| ${url} | ${info.type} | ${info.formCount} | ${info.fieldCount} | ${info.linkCount} |\n`;
  }

  // Discovered Flows
  md += `\n## Discovered Flows\n\n`;
  for (let i = 0; i < manifest.flows.length; i++) {
    const flow = manifest.flows[i];
    md += `### ${i + 1}. ${flow.name}\n\n`;
    md += `- **Type:** ${flow.type}\n`;
    md += `- **URL:** ${flow.url}\n`;
    md += `- **Priority:** ${flow.priority}\n`;
    md += `- **Fields:** ${flow.fieldCount}\n`;
    if (flow.entryPath.length > 0) {
      md += `- **Entry path:**\n`;
      for (const step of flow.entryPath) {
        md += `  1. ${step.action} (from ${step.fromUrl})\n`;
      }
    }
    if (flow.fields && flow.fields.length > 0) {
      md += `- **Form fields:**\n`;
      for (const f of flow.fields) {
        md += `  - ${f.label || f.name} (${f.type}${f.required ? ', required' : ''})\n`;
      }
    }
    md += `\n`;
  }

  // Flow Execution Results
  md += `## Execution Results\n\n`;
  md += `| # | Flow | Status | Steps | Duration | Test File |\n`;
  md += `|---|------|--------|-------|----------|----------|\n`;
  for (let i = 0; i < flowResults.results.length; i++) {
    const r = flowResults.results[i];
    const status = r.goalDone ? '✅ Complete' : r.goalStuck ? '⚠️ Stuck' : r.error ? '❌ Error' : '⏱️ Max Steps';
    const steps = r.steps ? `${r.steps.filter(s => s.success).length}/${r.steps.length}` : '-';
    const duration = r.duration ? `${r.duration.toFixed(1)}s` : '-';
    const testFile = r.testFilePath ? path.basename(r.testFilePath) : '-';
    md += `| ${i + 1} | ${r.flow.name} | ${status} | ${steps} | ${duration} | ${testFile} |\n`;
  }

  // Coverage Summary
  md += `\n## Coverage Summary\n\n`;
  const totalPages = Object.keys(manifest.siteMap).length;
  const formPages = Object.values(manifest.siteMap).filter(p => p.type === 'form' || p.type === 'wizard').length;
  const testedFlows = flowResults.results.filter(r => r.goalDone || (r.steps && r.steps.filter(s => s.success).length >= 3)).length;
  md += `- **Pages discovered:** ${totalPages}\n`;
  md += `- **Form pages:** ${formPages}\n`;
  md += `- **Flows tested:** ${testedFlows}/${manifest.flows.length}\n`;
  md += `- **Coverage:** ${manifest.flows.length > 0 ? Math.round((testedFlows / manifest.flows.length) * 100) : 0}%\n`;

  // Generated Test Files
  const testFiles = flowResults.results.filter(r => r.testFilePath).map(r => r.testFilePath);
  if (testFiles.length > 0) {
    md += `\n## Generated Test Files\n\n`;
    for (const f of testFiles) {
      md += `- \`${path.basename(f)}\`\n`;
    }
  }

  fs.writeFileSync(reportPath, md, 'utf8');
  logger.info(`[TestGenerator] Exploration report saved: ${reportPath}`);
  return reportPath;
}

/**
 * Save the flow manifest to a JSON file for later reference.
 *
 * @param {Object} manifest - Flow manifest from Site Explorer
 * @param {string} exploreName - Name for the exploration
 * @returns {string} Path to the saved manifest
 */
function saveManifest(manifest, exploreName) {
  const reportsDir = path.join(__dirname, '../../../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const safeName = (exploreName || 'explore').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const manifestPath = path.join(reportsDir, `manifest_${safeName}.json`);

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  logger.info(`[TestGenerator] Manifest saved: ${manifestPath}`);
  return manifestPath;
}

module.exports = { generateTestFile, generateAgentReport, generateExplorationReport, saveManifest };
