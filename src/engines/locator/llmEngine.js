/**
 * Code Generator Module
 * LLM-based Playwright code generation for test steps
 * Uses provider abstraction to support multiple LLM providers (Bedrock, OpenAI, etc.)
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const { getProvider } = require('../../providers/llm/providerFactory');
const ConversationManager = require('../../providers/llm/conversationManager');
const { extractText, parseSuggestions } = require('../../providers/llm/responseParser');
const { config } = require('../../providers/llm/llmConfig');
const { captureHybridInputData } = require('./pageDataCapture');
const { filterRelevantElements } = require('./elementFiltering');
const { paths: frameworkPaths } = require('../../config/frameworkConfig');
const {
  parseOrdinalLinkStep,
  buildOrdinalLinkLocatorFallbacks,
  ordinalLocatorIndexMatches,
} = require('../../utils/ordinalLinkStep');

function isDebugPromptsEnabled() {
  return (process.env.DEBUG_PROMPTS || '').toLowerCase() === 'true';
}

// LLM provider and conversation manager
let llmProvider = null;
let conversationManager = null;

/**
 * Initialize LLM provider
 * @returns {Promise<LLMProvider>}
 */
async function initializeLLMProvider() {
  if (!llmProvider) {
    try {
      llmProvider = await getProvider();
      conversationManager = new ConversationManager(llmProvider);
    } catch (error) {
      logger.error(`Failed to initialize LLM provider: ${error.message}`);
      throw error;
    }
  }
  return llmProvider;
}

/**
 * Compact system prompt for local/small models (Ollama)
 * ~600 chars vs ~3500 chars for the full prompt — much faster inference
 */
function getCompactSystemPrompt() {
  return {
    type: 'text',
    text: `You generate Playwright code from English test steps. Variables in scope: page, env (has baseUrl, credentials.email, credentials.password), expect.

Locator priority: data-testid > id > name > role > text > CSS.
Actions: click→.click(), fill→.fill(value), select→click dropdown then option, check→.check(), wait→waitForTimeout, navigate→page.goto(), verify→expect(...).toBeVisible().

Return ONLY JSON: {"suggestions":[{"code":"await page...","explanation":"why"}]}
Give 2 suggestions. For "Nth link with text X": prefer getByRole('button', { name: /X/i }).nth(N-1) for shopping cards, else getByRole('link').filter({ hasText: /X/i }).nth(N-1). Never use page.goto() to fix click failures.`,
    cache_control: { type: 'ephemeral' }
  };
}

/**
 * Get the system prompt for code generation
 * @returns {Object}
 */
function getSystemPrompt() {
  // Use compact prompt for local models
  if (config.provider === 'ollama') {
    return getCompactSystemPrompt();
  }

  return {
    type: 'text',
    text: `You are a Playwright code generator. Given a plain-English test step and a snapshot of the page's interactive elements, you produce executable Playwright code.

# CORE TASK
Translate a natural-language step (e.g. "Click Save button", "Enter 'hello' in search field") into a single block of Playwright code that performs exactly that action. The code will be eval'd inside an async function with these variables in scope:
  - page  (Playwright Page object)
  - env   (environment config with: baseUrl, credentials.email, credentials.password, company, businessUnit, and many other fields)
  - expect (Playwright expect)
  - generateUniqueAlphabeticString() — returns a unique string

# STEP INTERPRETATION RULES
Parse the step description to determine:
1. **Action**: click, fill/enter/type, select, check, wait, navigate, verify/check/assert
2. **Target**: the element (button, link, input, dropdown, checkbox, etc.)
3. **Value**: text to enter, option to select, URL to navigate to, etc.

Mapping natural language → Playwright actions:
- "Click [X]" → .click()
- "Enter/Fill/Type [value] in [field]" → .fill(value) or .type(value) for "slowly"  
- "Select [option]" → .click() the dropdown then .click() the option, or .selectOption()
- "Check [checkbox]" → .check()
- "Wait for page to load" → await page.waitForLoadState('networkidle');
- "Wait for N seconds" → await page.waitForTimeout(N * 1000);
- "Navigate to [URL]" → await page.goto(URL, { waitUntil: 'domcontentloaded' });
- "Verify/Check [text] is displayed" → await expect(page.getByText(text)).toBeVisible();

When the step contains a quoted value like "Alex", use that exact value. When it says things like "Enter Email" without a value, use the env config (e.g., env.credentials.email or env.customerEmail).

# LOCATOR STRATEGY (strict priority)
Given the element data provided, choose locators in this order:
1. **data-testid** → page.getByTestId('value')
2. **testdataid** → page.locator('[testdataid="value"]')
3. **id** (use EXACTLY as shown, never abbreviate) → page.locator('#exact-id')
4. **name attribute** → page.locator('[name="value"]') or page.locator('input[name="value"]')
5. **role + accessible name** → page.getByRole('button', { name: 'Text' })
6. **label text** → page.getByLabel('Label Text')
7. **placeholder** → page.getByPlaceholder('placeholder text')
8. **text content** → page.getByText('visible text')
9. **CSS selector** as fallback

CRITICAL RULES:
- **FIRST INSTANCE RULE**: When multiple similar elements exist on the page (e.g. two "First Name" fields), ALWAYS target the FIRST instance in DOM order (lowest domOrder number) unless the step explicitly says otherwise (e.g. "second", "Service Address", etc.). The first instance is typically in the primary form and has richer attributes like data-testid.
- **DATA-TESTID IS KING**: If an element has a data-testid attribute, you MUST use page.getByTestId() for it. NEVER use name, id, or other attributes when data-testid is available on that element. For example, if an input has data-testid="wo-customer-input-firstName" AND name="fName", ALWAYS use getByTestId('wo-customer-input-firstName'), NEVER use input[name="fName"].
- When duplicates exist, the element with data-testid is almost always the correct target (the primary form field). An element WITHOUT data-testid is usually a secondary/duplicate field.
- NEVER use empty text filters like .filter({ hasText: '' })
- Avoid bare getByText('...').first() when multiple matches exist
- Use EXACT attribute values from the element data — never simplify IDs
- Elements include domOrder (ascending in the list). For duplicate text, lower domOrder = earlier on page.
- **ORDINAL LINK STEPS** (e.g. "Click on 2nd link with text Ideapad Slim"): click the Nth clickable whose label contains the text. On shopping grids use role="button" + aria-label (e.g. getByRole('button', { name: /Ideapad\\s+Slim/i }).nth(1)). Also try href from element list. 0-based .nth index = ordinal−1.

# HANDLING ERRORS (when original code failed)
If original code and error message are provided:
1. Read the error carefully — it often contains the actual DOM elements with their attributes
2. Extract data-testid/testdataid from error messages — these are gold
3. If "strict mode violation" → multiple elements matched → use a more specific locator
4. If "timeout" → element may not exist yet → add waitFor or check if element type/text is different on the actual page
5. Provide a DIFFERENT strategy than the one that failed

# RESPONSE FORMAT
Return ONLY a valid JSON object (no markdown, no explanation outside JSON):
{
  "suggestions": [
    {
      "code": "await page.getByTestId('save-btn').click();",
      "explanation": "Uses data-testid for reliable targeting"
    },
    {
      "code": "await page.getByRole('button', { name: 'Save' }).click();",
      "explanation": "Fallback using accessible role and name"
    }
  ]
}

RULES:
- Provide 2-3 suggestions, ordered most → least reliable
- Each "code" must be complete, runnable Playwright code with await
- Do NOT wrap in markdown code blocks — return raw JSON only
- For clicks that trigger navigation, add: await page.waitForLoadState('networkidle'); after the click
- For "type slowly" steps, use page.locator(...).pressSequentially(text, { delay: 100 }) instead of .fill()

# FORBIDDEN PATTERNS (never suggest these)
- **NEVER use page.goto()** as a fix for a failed click/interaction step. If the step says "Click X", you must locate and click the element — not navigate to a URL.
- **NEVER use page.evaluate() with raw DOM clicks** (e.g. element.click() inside evaluate). Always use Playwright's built-in locator methods.
- **NEVER construct URLs from env variables** as a workaround for element interaction failures.
- **NEVER use auto-generated or dynamic IDs** that contain colons or random characters (e.g. #\\:r1g\\:, #\\:rs\\:). These change between sessions and will break.
- For ordinal link steps, .nth(N) is correct when N = ordinal−1 (2nd link → .nth(1)). Scope with getByRole('link').filter({ hasText: /.../i }) or getByText(/.../i).
- **NEVER use .filter({ hasText: '' })** — empty text filter matches everything.
- All suggestions must use stable Playwright locator APIs (getByTestId, getByRole, getByText, getByLabel, getByPlaceholder, locator with stable attributes).`,
    cache_control: { type: 'ephemeral' }
  };
}

/**
 * Initialize conversation session with static system prompt
 * This is called once at the start of a test run
 */
async function initializeConversationSession() {
  await initializeLLMProvider();
  
  if (conversationManager.initialized) {
    logger.info('Conversation session already initialized');
    return;
  }

  conversationManager.initialize(getSystemPrompt());
}

/**
 * Reset conversation session (called at end of test run)
 */
function resetConversationSession() {
  if (conversationManager) {
    conversationManager.reset();
  }
  logger.info('Conversation session reset');
}

/**
 * Generate Playwright code suggestions for a test step using LLM
 * @param {Object} page - Playwright page object
 * @param {string} step - Test step description
 * @param {string} originalCode - Original code that failed (if any)
 * @param {string} errorMessage - Error message from failed code (if any)
 * @param {string} htmlContent - HTML content (deprecated, not used)
 * @param {string} runDir - Optional run directory for debug files
 * @returns {Promise<Array>} - Array of code suggestions with explanations
 */
async function suggestAlternativeLocators(page, step, originalCode, errorMessage, htmlContent = null, runDir = null) {
  logger.info(`AI code generation for step: "${step}"`);
  
  // Check if AI healing is enabled — default to true when env var is not set
  const aiHealingEnabled = process.env.AI_HEALING_ENABLED !== undefined
    ? process.env.AI_HEALING_ENABLED.toLowerCase() === 'true'
    : true;
  
  if (!aiHealingEnabled) {
    logger.warning('AI healing is disabled. Set AI_HEALING_ENABLED=true to enable it.');
    return [];
  }
  
  await initializeLLMProvider();
  if (!llmProvider) {
    logger.error('LLM provider could not be initialized. Check configuration.');
    return [];
  }
  
  try {
    // Get current URL
    let currentUrl = 'Unknown';
    try { currentUrl = await page.url(); } catch (_) {}
    
    // Capture hybrid input data with progressive retry
    let hybridData = await captureHybridInputData(page, runDir, step);
    if (!hybridData || hybridData.length === 0) {
      logger.info('No elements found, waiting for page to stabilize...');
      const retryDelays = [3000, 5000, 5000]; // progressive waits
      for (let i = 0; i < retryDelays.length; i++) {
        try {
          await page.waitForLoadState('networkidle', { timeout: 10000 });
          await page.waitForTimeout(retryDelays[i]);
          hybridData = await captureHybridInputData(page, runDir, step);
          if (hybridData && hybridData.length > 0) {
            logger.info(`Retry ${i + 1}: captured ${hybridData.length} elements after ${retryDelays[i]}ms wait`);
            break;
          }
          logger.info(`Retry ${i + 1}: still 0 elements, waiting longer...`);
        } catch (_) {}
      }
    }
    
    // Filter elements by relevance to the step — keeps prompt small for local models
    const totalOnPage = hybridData ? hybridData.length : 0;
    const relevantElements = filterRelevantElements(hybridData || [], step);
    const sentCount = relevantElements.length;
    logger.info(`Sending ${sentCount} relevant elements from ${totalOnPage} total for step: "${step}"`);
    
    // Format for prompt — use compact format for Ollama, full JSON for others
    let elementsJson = 'No interactive elements found on page.';
    let fullElementsJson = null;
    if (relevantElements.length > 0) {
      const compact = relevantElements.map((el, idx) => {
        const clean = { domOrder: idx + 1, ...el };
        delete clean.position;
        if (clean.attributes) {
          clean.attributes = Object.fromEntries(
            Object.entries(clean.attributes).filter(([_, v]) => v != null && v !== '')
          );
        }
        return clean;
      });
      fullElementsJson = JSON.stringify(compact, null, 1);
      
      // Use ultra-compact format for Ollama (small models)
      if (config.provider === 'ollama') {
        const lines = compact.map(el => {
          const attrs = [];
          if (el.attributes?.['data-testid']) attrs.push(`data-testid=${el.attributes['data-testid']}`);
          if (el.attributes?.id) attrs.push(`id=${el.attributes.id}`);
          if (el.attributes?.name) attrs.push(`name=${el.attributes.name}`);
          if (el.attributes?.placeholder) attrs.push(`placeholder=${el.attributes.placeholder}`);
          if (el.attributes?.['aria-label']) attrs.push(`aria-label=${el.attributes['aria-label']}`);
          if (el.type) attrs.push(`type=${el.type}`);
          const text = el.text ? ` | text="${el.text.substring(0, 30)}"` : '';
          return `${el.domOrder} | ${el.tag} | ${attrs.join(', ')}${text}`;
        });
        elementsJson = lines.join('\n');
      } else {
        elementsJson = fullElementsJson;
        if (elementsJson.length > 12000) {
          elementsJson = elementsJson.substring(0, 12000) + '\n...(truncated)';
        }
      }
    }
    
    // Initialize conversation session if not already done
    await initializeConversationSession();
    
    // Build focused dynamic prompt
    const elementHeader = config.provider === 'ollama' 
      ? `Elements (${sentCount} of ${totalOnPage}, domOrder ascending):\n`
      : `Page elements (${sentCount} of ${totalOnPage} shown, filtered by relevance, domOrder=1 is FIRST on page — prefer lower domOrder):\n`;
    
    const ordinalStep = parseOrdinalLinkStep(step);
    const ordinalHint = ordinalStep
      ? `\nORDINAL LINK: Click the ${ordinalStep.ordinal}${ordinalStep.ordinal === 1 ? 'st' : ordinalStep.ordinal === 2 ? 'nd' : ordinalStep.ordinal === 3 ? 'rd' : 'th'} item containing "${ordinalStep.text}". `
        + `On Google Shopping these are often role="button" with aria-label (not <a>). Prefer page.getByRole('button', { name: /${ordinalStep.text.replace(/\s+/g, '\\s+')}/i }).nth(${ordinalStep.index}) `
        + `or the ${ordinalStep.ordinal}th matching row's aria-label/href from the element list.\n`
      : '';

    const dynamicPrompt = `Step: ${step}
URL: ${currentUrl}
${originalCode && !originalCode.includes('No existing code') ? `Original code (failed): ${originalCode}\nError: ${errorMessage}` : `Context: ${errorMessage || 'New step — generate from scratch'}`}
${ordinalHint}
${elementHeader}${elementsJson}

Return JSON with suggestions array.`;
    
    logger.info(`Prompt: ${dynamicPrompt.length} chars, conversation: ${conversationManager.getHistory().length} messages`);
    
    // Prepare debug file paths (only when DEBUG_PROMPTS=true)
    let debugFile = null;
    if (isDebugPromptsEnabled()) {
      const promptDir = frameworkPaths.debugPrompts;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const stepSlug = step.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_');

      try {
        if (!fs.existsSync(promptDir)) {
          fs.mkdirSync(promptDir, { recursive: true });
        }
        debugFile = path.join(promptDir, `${timestamp}_${stepSlug}.txt`);
        const systemPromptText = typeof conversationManager.getSystemPrompt() === 'string' 
          ? conversationManager.getSystemPrompt() 
          : conversationManager.getSystemPrompt().text;
        const header = `=== PROVIDER: ${config.provider} | MODEL: ${config[config.provider]?.model || config[config.provider]?.modelId || 'unknown'} ===\n\n`;
        const fullPrompt = header + `=== SYSTEM PROMPT (${systemPromptText.length} chars) ===\n${systemPromptText}\n\n=== USER PROMPT (${dynamicPrompt.length} chars) ===\n${dynamicPrompt}`;
        fs.writeFileSync(debugFile, fullPrompt, 'utf8');
        logger.info(`Debug prompt saved to: ${debugFile}`);

        // Save full (non-truncated) elements to a separate file
        if (fullElementsJson && fullElementsJson !== elementsJson) {
          const fullFile = path.join(promptDir, `${timestamp}_${stepSlug}_FULL_ELEMENTS.json`);
          fs.writeFileSync(fullFile, fullElementsJson, 'utf8');
          logger.info(`Full elements (${fullElementsJson.length} chars) saved to: ${fullFile}`);
        }
      } catch (err) {
        logger.warning(`Failed to save debug prompt: ${err.message}`);
      }
    }
    
    logger.info(`Using model: ${config.provider} (${config[config.provider]?.model || config[config.provider]?.modelId || 'unknown'})`);
    
    // Call LLM provider with retry
    let responseBody;
    const llmStart = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        responseBody = await llmProvider.generateCode(
          conversationManager.getSystemPrompt(),
          dynamicPrompt,
          conversationManager.getHistory()
        );
        break;
      } catch (err) {
        if (attempt >= 3) {
          // Append error to debug file
          if (debugFile) {
            try {
              const elapsed = ((Date.now() - llmStart) / 1000).toFixed(1);
              fs.appendFileSync(debugFile, `\n\n=== LLM ERROR (after ${elapsed}s, ${attempt} attempts) ===\n${err.message}`, 'utf8');
            } catch (_) {}
          }
          throw err;
        }
        logger.warning(`LLM call failed (attempt ${attempt}/3): ${err.message}`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
    
    // Extract text from response
    const assistantMessage = extractText(responseBody, llmProvider.getName());
    
    if (!assistantMessage) {
      logger.error('Empty response from LLM');
      if (debugFile) {
        try { fs.appendFileSync(debugFile, `\n\n=== LLM RESPONSE ===\n(empty)\n\n=== RAW RESPONSE ===\n${JSON.stringify(responseBody, null, 2)}`, 'utf8'); } catch (_) {}
      }
      return [];
    }
    
    // Append LLM response to the same debug file
    if (debugFile) {
      try {
        const elapsed = ((Date.now() - llmStart) / 1000).toFixed(1);
        fs.appendFileSync(debugFile, `\n\n=== LLM RESPONSE (${elapsed}s) ===\n${assistantMessage}`, 'utf8');
        logger.info(`LLM response appended to: ${debugFile}`);
      } catch (err) {
        logger.warning(`Failed to save LLM response to file: ${err.message}`);
      }
    }

    // Parse suggestions with unified parser
    let suggestions = parseSuggestions(assistantMessage);

    if (ordinalStep) {
      const before = suggestions.length;
      suggestions = suggestions.filter((code) => {
        if (!/\.(?:first|nth)\(/i.test(code)) return true;
        return ordinalLocatorIndexMatches(step, code);
      });
      if (before > suggestions.length) {
        logger.warning(
          `Rejected ${before - suggestions.length} LLM suggestion(s) with wrong .first()/.nth() index for ordinal link`,
        );
      }
    }

    if (suggestions.length === 0 && ordinalStep) {
      suggestions = buildOrdinalLinkLocatorFallbacks(ordinalStep.ordinal, ordinalStep.text);
      if (suggestions.length > 0) {
        logger.info(`Using ${suggestions.length} built-in ordinal link locator(s) for "${step}"`);
      }
    }

    if (suggestions.length === 0) {
      logger.warning(
        `LLM returned no valid locators (${llmProvider.getName()}). `
        + 'Small models often truncate JSON — try a larger model or rely on the action library.'
      );
    }

    logger.info(`LLM returned ${suggestions.length} valid locator(s) (${llmProvider.getName()})`);
    suggestions.forEach((code, i) => {
      logger.info(`  LLM locator ${i + 1}: ${code}`);
    });

    if (debugFile && suggestions.length > 0) {
      try {
        const locatorBlock = suggestions.map((c, i) => `${i + 1}. ${c}`).join('\n');
        fs.appendFileSync(debugFile, `\n\n=== PARSED LOCATORS ===\n${locatorBlock}`, 'utf8');
      } catch (_) { /* ignore */ }
    }
    
    // Update conversation history
    conversationManager.addMessage('user', dynamicPrompt);
    conversationManager.addMessage('assistant', assistantMessage);
    
    // Keep conversation history within context budget
    // Small-context models (Ollama): keep only last 2 messages (1 exchange) to save tokens
    // Large-context models (Bedrock/OpenAI): keep last 4 messages (2 exchanges)
    const maxHistory = config.provider === 'ollama' ? 2 : 4;
    const history = conversationManager.getHistory();
    if (history.length > maxHistory) {
      conversationManager.messages = history.slice(-maxHistory);
      if (process.env.OPENSECANT_VERBOSE === 'true') {
        logger.info(`Conversation trimmed to last ${maxHistory} messages (provider: ${config.provider})`);
      }
    }
    
    return suggestions;
  } catch (error) {
    logger.error(`Error calling LLM: ${error.message}`);
    return [];
  }
}

module.exports = {
  suggestAlternativeLocators,
  initializeConversationSession,
  resetConversationSession
};
