/**
 * LLM-assisted flow discovery from a crawled site map.
 */
const logger = require('../../utils/logger');
const { getProvider } = require('../../providers/llm/providerFactory');
const { extractText } = require('../../providers/llm/responseParser');

function buildSiteMapSummary(siteMap, startUrl) {
  const pages = Object.entries(siteMap).slice(0, 25).map(([url, info]) => ({
    url,
    title: info.title,
    heading: info.heading,
    type: info.type,
    forms: (info.forms || []).length,
    fields: (info.forms || []).reduce((s, f) => s + (f.fieldCount || 0), 0) + (info.standaloneFields || []).length,
    topLinks: [...(info.navLinks || []), ...(info.links || [])]
      .slice(0, 12)
      .map((l) => ({ text: l.text, href: l.href })),
    buttons: (info.buttons || []).slice(0, 8).map((b) => b.text),
  }));

  return JSON.stringify({ startUrl, pages }, null, 1);
}

function parseFlowsJson(text) {
  if (!text) return [];
  const block = text.match(/\{[\s\S]*"flows"[\s\S]*\}/);
  if (!block) return [];
  try {
    const parsed = JSON.parse(block[0].replace(/,\s*]/g, ']').replace(/,\s*}/g, '}'));
    if (Array.isArray(parsed.flows)) return parsed.flows;
  } catch (_) { /* fall through */ }
  return [];
}

/**
 * Ask LLM to propose testable flows from site map.
 * @returns {Promise<Array>}
 */
async function discoverFlowsWithLLM(siteMap, startUrl) {
  const pageCount = Object.keys(siteMap).length;
  if (pageCount === 0) return [];

  try {
    const provider = await getProvider();
    const summary = buildSiteMapSummary(siteMap, startUrl);

    const systemPrompt = `You are a QA architect. Given a website crawl summary, propose testable user journeys.
Return ONLY valid JSON:
{"flows":[{"name":"short name","type":"form|navigation|multi-step","url":"https://...","priority":"high|medium|low","entryPath":[{"action":"plain english step"}],"goal":"single sentence goal for an autonomous QA agent","submitText":""}]}
Rules:
- Propose 3-8 flows covering contact, demo, login, product, support paths when present.
- Use real URLs from the site map.
- entryPath = steps to reach the flow from home (click links, etc.).
- goal = what the QA agent should accomplish on that journey.`;

    const userPrompt = `Site: ${startUrl}\nPages crawled: ${pageCount}\n\n${summary}\n\nList testable flows as JSON.`;

    logger.info(`[FlowDiscovery] Asking LLM for flows (${summary.length} chars context)...`);

    const response = await provider.generateCode(
      { type: 'text', text: systemPrompt },
      userPrompt,
      []
    );

    const text = extractText(response, provider.getName());
    let flows = parseFlowsJson(text);

    if (flows.length === 0 && text) {
      const codeBlocks = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlocks) flows = parseFlowsJson(codeBlocks[1]);
    }

    logger.info(`[FlowDiscovery] LLM proposed ${flows.length} flow(s)`);
    return flows.map((f) => ({
      name: String(f.name || 'flow').substring(0, 60),
      type: f.type || 'navigation',
      url: f.url || startUrl,
      entryPath: Array.isArray(f.entryPath) ? f.entryPath : [],
      priority: f.priority || 'medium',
      goal: f.goal || `On ${startUrl} complete the ${f.name} journey`,
      submitText: f.submitText || '',
      fieldCount: f.fieldCount || 0,
      source: 'llm',
    }));
  } catch (err) {
    logger.warning(`[FlowDiscovery] LLM flow discovery failed: ${err.message}`);
    return [];
  }
}

module.exports = {
  discoverFlowsWithLLM,
  buildSiteMapSummary,
};
