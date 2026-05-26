/**
 * Action Planner — LLM-based decision engine for the QA Agent.
 *
 * Given a high-level goal (e.g. "perform a booking") and the current page
 * state (URL, visible elements), the planner outputs the NEXT natural-language
 * test step to execute (e.g. "Click on Schedule Service").
 *
 * The step is then fed into the existing pipeline:
 *   StepStore → Action Library → LLM code generator
 */

const logger = require('../../utils/logger');
const { getProvider } = require('../../providers/llm/providerFactory');
const { extractText } = require('../../providers/llm/responseParser');
const { config } = require('../../providers/llm/llmConfig');

let plannerProvider = null;

async function initPlanner() {
  if (!plannerProvider) {
    plannerProvider = await getProvider();
  }
  return plannerProvider;
}

/**
 * Build the system prompt for the action planner.
 */
function getSystemPrompt() {
  return `You are a QA Agent that navigates websites and performs tasks. You analyze the current page and decide the NEXT single action to take toward completing the user's goal.

# RULES
1. Output EXACTLY ONE action per response — a plain-English test step.
2. Use simple imperative sentences the test framework understands:
   - "open <url>" — navigate
   - "click on <element>" — click a button/link
   - "fill <field> as <value>" — fill a text field (NO quotes around the value!)
   - "enter <value> in to <field>" — alternate fill syntax
   - "select <value> from <dropdown>" — select dropdown option
   - "check <checkbox label>" — check a checkbox
   - "wait for page to load" — wait for page stability
   - "wait for <N> seconds" — hard wait
   - "close the <modal> if it is open" — dismiss overlay
   - "verify <element> is displayed" — assertion
3. For form fields, use REALISTIC test data (NO surrounding quotes — write plain values):
   - fill First Name as TestUser
   - fill Last Name as AutoGen
   - fill email as testuser@example.com
   - fill phone as 9876543210
   - fill zip code as 10001
   - fill address as 123 Test Street
   - For other fields, infer sensible values from the field label.
4. IMPORTANT: Do NOT put quotes around fill values. Write: fill First Name as TestUser  NOT: fill First Name as "TestUser"
5. When you see a modal/popup/overlay blocking the page, close it FIRST.
6. After filling ALL required form fields, click the submit/continue button.
7. After a navigation-triggering click, output "wait for page to load" as the next step.
8. When the goal appears complete (e.g. confirmation page, success message), output exactly: GOAL_COMPLETE
9. If you are stuck and cannot proceed, output exactly: GOAL_STUCK
10. Do NOT repeat an action that already failed. Try a different approach.
11. Do NOT output code — only plain English steps.
12. Do NOT output multiple steps — only ONE step per response.
13. If the page has multiple similar elements, be specific (e.g. "click on Schedule Service button in the header").
14. CRITICAL: Pay attention to the URL. If the URL did NOT change after a submit/click, the form likely had VALIDATION ERRORS. Look at the page for error messages and fix the issue instead of re-filling the same form.
15. If the page shows validation errors (like "Invalid format", "required field"), read them and adjust your action accordingly.
16. If you see a multi-step form/wizard (progress bar, step indicators), recognize which step you are on and only fill fields visible on the CURRENT step.
17. NEVER repeat the exact same sequence of actions you already performed. If you already filled and submitted a form, and the URL didn't change, something went wrong — do NOT just refill the same form again.`;
}

/**
 * Ask the planner for the next action.
 *
 * @param {string} goal - High-level user goal
 * @param {string} currentUrl - Current page URL
 * @param {Array} elements - Page elements (from hybrid capture)
 * @param {Array} history - Array of { step, success, error? } for context
 * @param {number} stepNumber - Current step number
 * @returns {Promise<{ step: string, done: boolean, stuck: boolean }>}
 */
async function planNextAction(goal, currentUrl, elements, history, stepNumber, extra = {}) {
  const provider = await initPlanner();

  // Build concise element summary for the planner
  const elementSummary = summarizeElements(elements);

  // Build history context (show last 15 steps max to save tokens)
  const recentHistory = history.slice(-15);
  const historyText = recentHistory.length > 0
    ? recentHistory.map((h, i) => {
        const idx = history.length - recentHistory.length + i + 1;
        return `  ${idx}. ${h.step} → ${h.success ? 'OK' : 'FAILED: ' + (h.error || 'unknown')}`;
      }).join('\n')
    : '  (none yet)';

  // URL change detection
  const prevUrl = extra.previousUrl || '';
  const urlChanged = prevUrl && prevUrl !== currentUrl;
  const urlNote = prevUrl
    ? (urlChanged ? `- URL CHANGED from ${prevUrl} → ${currentUrl}` : `- ⚠️ URL DID NOT CHANGE (still: ${currentUrl}) — check for validation errors on the page`)
    : `- URL: ${currentUrl}`;

  // Submit-on-same-URL warning
  const submitCount = extra.submitCountOnThisUrl || 0;
  const submitWarning = submitCount >= 1
    ? `\n- 🚨 CRITICAL: You have already submitted/clicked a form button on this page ${submitCount} time(s) and the URL DID NOT CHANGE. The form is NOT progressing. Do NOT fill the same form again. Either: (a) fix a specific validation error, (b) try a completely different element, or (c) output GOAL_STUCK.`
    : '';

  // Loop detection warning
  const loopWarning = extra.loopDetected
    ? '\n- ⚠️ LOOP DETECTED: You are repeating the same actions. The form may have validation errors, or the page did not progress. Try a DIFFERENT approach or output GOAL_STUCK.'
    : '';

  // Validation errors (if captured — only show if actually present)
  const errorNote = extra.validationErrors && extra.validationErrors.length > 0
    ? '\n- ⚠️ VALIDATION ERRORS ON PAGE:\n' + extra.validationErrors.map(e => `    - ${e}`).join('\n')
    : '';

  // Intelligent recovery context
  let recoveryContext = '';
  if (extra.consecutiveFailures >= 2) {
    recoveryContext += `\n\n🚨 CRITICAL FAILURE CONTEXT:\n- ${extra.consecutiveFailures} consecutive steps have FAILED\n- Recent failures:\n`;
    if (extra.recentFailures && extra.recentFailures.length > 0) {
      recoveryContext += extra.recentFailures.map(f => `  • "${f.step}" failed: ${f.error}`).join('\n');
    }
    recoveryContext += `\n\n⚠️ IMPORTANT: The current approach is NOT working. You MUST try a COMPLETELY DIFFERENT strategy:\n`;
    recoveryContext += `- Try clicking different elements (e.g., if button fails, try link or menu item)\n`;
    recoveryContext += `- Use keyboard navigation (press Tab, Enter, Escape)\n`;
    recoveryContext += `- Break complex actions into smaller steps\n`;
    recoveryContext += `- Look for alternative paths (different menus, navigation options)\n`;
    recoveryContext += `- If an element is blocked by overlay, close the overlay first\n`;
    recoveryContext += `- Consider if this section is broken and should be skipped\n`;
  }

  if (extra.requestingAlternative) {
    recoveryContext += `\n\n🔄 ALTERNATIVE APPROACH REQUESTED:\n`;
    recoveryContext += `The step "${extra.failedStep}" has failed multiple times.\n`;
    recoveryContext += `Suggest a COMPLETELY DIFFERENT way to achieve the same goal.\n`;
    recoveryContext += `Think creatively - use different elements, different navigation, or break it into steps.\n`;
  }

  if (extra.criticalFailure) {
    recoveryContext += `\n\n🆘 CRITICAL RECOVERY MODE:\n`;
    recoveryContext += `${extra.consecutiveFailures} consecutive failures detected. This section may be broken.\n`;
    recoveryContext += `Options:\n`;
    recoveryContext += `1. Skip this section and continue with next logical step\n`;
    recoveryContext += `2. Try a completely different path to achieve the goal\n`;
    recoveryContext += `3. Output GOAL_STUCK if this is essential and cannot be bypassed\n`;
  }

  const userPrompt = `# GOAL
${goal}

# CURRENT STATE
${urlNote}
- Step number: ${stepNumber}
- Total actions so far: ${history.length}${submitWarning}${loopWarning}${errorNote}${recoveryContext}
- Actions taken so far:
${historyText}

# VISIBLE PAGE ELEMENTS
${elementSummary}

# TASK
Based on the goal and current page state, what is the SINGLE next action to take?
IMPORTANT: Do NOT put quotes around fill values. Write plain values like: fill First Name as TestUser
Output ONLY the action step (plain English) or GOAL_COMPLETE if done or GOAL_STUCK if stuck.`;

  logger.info(`[ActionPlanner] Asking LLM for next action (step ${stepNumber})...`);

  try {
    const systemPrompt = getSystemPrompt();
    const responseBody = await provider.generateCode(systemPrompt, userPrompt, []);

    const responseText = extractText(responseBody, provider.getName());
    if (!responseText) {
      logger.error('[ActionPlanner] Empty response from LLM');
      return { step: null, done: false, stuck: true };
    }

    // Clean up the response — extract just the first non-empty line
    const cleaned = responseText.trim().split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    logger.info(`[ActionPlanner] LLM suggested: "${cleaned}"`);

    if (/^GOAL_COMPLETE$/i.test(cleaned)) {
      return { step: null, done: true, stuck: false };
    }
    if (/^GOAL_STUCK$/i.test(cleaned)) {
      return { step: null, done: false, stuck: true };
    }

    // Strip any leading numbering like "1." or "Step 1:" or markdown
    const step = cleaned
      .replace(/^(?:step\s*\d+[:.]\s*)/i, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^`(.+)`$/, '$1')
      .trim();

    return { step, done: false, stuck: false };
  } catch (err) {
    logger.error(`[ActionPlanner] LLM error: ${err.message}`);
    return { step: null, done: false, stuck: true };
  }
}

/**
 * Summarize page elements into a compact text format for the planner.
 * Groups by category: forms, buttons/links, headings, modals.
 */
function summarizeElements(elements) {
  if (!elements || elements.length === 0) return '(no elements captured)';

  const lines = [];
  const forms = [];
  const buttons = [];
  const links = [];
  const modals = [];
  const other = [];

  for (const el of elements) {
    const tag = el.tag || '';
    const text = (el.text || '').trim().substring(0, 80);
    const testId = el.attributes?.['data-testid'] || el.attributes?.['testdataid'] || '';
    const name = el.attributes?.name || '';
    const placeholder = el.attributes?.placeholder || '';
    const type = el.type || '';
    const role = el.accessibility?.role || el.attributes?.role || '';

    // Classify element
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const label = el.label || el.labelText || placeholder || name || testId;
      const fieldType = tag === 'select' ? 'dropdown' : (type || 'text');
      forms.push(`  [${fieldType}] "${label}"${testId ? ` (testid: ${testId})` : ''}${name ? ` (name: ${name})` : ''}`);
    } else if (tag === 'button' || type === 'submit' || role === 'button') {
      buttons.push(`  [button] "${text}"${testId ? ` (testid: ${testId})` : ''}`);
    } else if (tag === 'a' || role === 'link') {
      links.push(`  [link] "${text}"${testId ? ` (testid: ${testId})` : ''}`);
    } else if (/close|modal|dialog|overlay|popup/i.test(text + testId + role)) {
      modals.push(`  [modal] "${text}"${testId ? ` (testid: ${testId})` : ''}`);
    } else if (text && text.length > 3) {
      other.push(`  [${tag}] "${text}"`);
    }
  }

  if (modals.length > 0) lines.push('## Modals/Popups\n' + modals.join('\n'));
  if (forms.length > 0) lines.push('## Form Fields\n' + forms.join('\n'));
  if (buttons.length > 0) lines.push('## Buttons\n' + buttons.join('\n'));
  if (links.length > 0) lines.push('## Links\n' + links.join('\n'));
  if (other.length > 0 && other.length <= 15) lines.push('## Other Elements\n' + other.join('\n'));

  const summary = lines.join('\n\n');
  // Cap at ~4000 chars to avoid token limits
  return summary.length > 4000 ? summary.substring(0, 4000) + '\n... (truncated)' : summary;
}

module.exports = { planNextAction, initPlanner };
