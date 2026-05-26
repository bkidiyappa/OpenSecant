/**
 * QA Agent — autonomous website explorer and test generator.
 *
 * Given a high-level goal (e.g. "On this website perform a booking"),
 * the agent:
 *   1. Launches a browser and navigates to the target URL
 *   2. Captures page elements (hybrid data capture)
 *   3. Asks the Action Planner LLM for the next step
 *   4. Executes the step via: StepStore → Action Library → LLM code gen
 *   5. Records successful step + code
 *   6. Repeats until goal is complete or max steps reached
 *   7. Generates a .test file and agent report
 *
 * Usage:
 *   node runner.js --agent "On https://example.com perform a booking"
 *   node runner.js --agent "On https://example.com fill the contact form" --agent-name contact-form
 */

const path = require('path');
const logger = require('../../utils/logger');
const { captureHybridInputData } = require('../locator/pageDataCapture');
const { filterRelevantElements } = require('../locator/elementFiltering');
const { tryActionLibrary, getActionType } = require('../locator/locatorResolver');
const { suggestAlternativeLocators, resetConversationSession } = require('../locator/llmEngine');
const { getStepStore } = require('../../store/stepStore');
const { generateUniqueAlphabeticString } = require('../../utils/uniqueStringGenerator');
const { expect } = require('@playwright/test');
const { planNextAction } = require('./actionPlanner');
const { generateTestFile, generateAgentReport } = require('./testGenerator');
const { launchBrowser, getDefaultContextOptions, newPage } = require('../../runner/browserLauncher');
const { sanitizePlaywrightCode } = require('../../providers/llm/responseParser');
const { summarizeExecError } = require('../../utils/execError');

const MAX_STEPS = 130;
const MAX_CONSECUTIVE_FAILURES = 3;
const LOOP_WINDOW = 8; // detect loops within the last N steps

/**
 * Safely execute a Playwright code string (same as stepExecutor.execCode)
 */
async function execCode(page, code) {
  const cleaned = sanitizePlaywrightCode(code);
  if (!cleaned) {
    throw new Error('Empty or invalid Playwright code after sanitization');
  }
  const fn = new Function(
    'page', 'env', 'generateUniqueAlphabeticString', 'expect',
    `return (async () => { ${cleaned} })();`
  );
  await fn(page, global.env, generateUniqueAlphabeticString, expect);
}

/**
 * Wait for page stability after actions that trigger navigation.
 */
async function waitForPageStable(page) {
  try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch (_) { }
  try { await page.waitForTimeout(1500); } catch (_) { return; }
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (_) { }
}

/**
 * Check if a step likely causes navigation.
 */
function causesNavigation(step) {
  return /click|submit|continue|search|book|schedule/i.test(step)
    && !/(checkbox|radio|dropdown|field|input|select|toggle|expand|add\s|residential|commercial|option|tab)/i.test(step);
}

/**
 * Execute a single step using the existing resolution pipeline:
 *   StepStore → Action Library → LLM code generation
 *
 * @returns {{ success: boolean, code: string|null, source: string, error: string|null }}
 */
async function executeAgentStep(page, step, runDir) {
  const stepStore = getStepStore();
  const stepClean = step.replace(/^\d+\.\s*/, '').trim();

  // 1. StepStore exact match
  const cachedCode = stepStore.resolve(stepClean);
  if (cachedCode) {
    logger.info(`[Agent] StepStore hit: "${stepClean}"`);
    try {
      await execCode(page, cachedCode);
      logger.success(`[Agent] Step executed from StepStore`);
      if (causesNavigation(step)) await waitForPageStable(page);
      return { success: true, code: cachedCode, source: 'stepstore', error: null };
    } catch (err) {
      logger.warning(`[Agent] StepStore code failed: ${summarizeExecError(err)}`);
    }
  }

  // 2. Action Library (deterministic)
  const actionType = getActionType(stepClean);
  logger.info(`[Agent] Action type: ${actionType}`);

  const ELEMENT_FREE = new Set(['navigate', 'hardWait']);
  if (ELEMENT_FREE.has(actionType)) {
    const fastCandidates = tryActionLibrary(stepClean, []) || [];
    for (const code of fastCandidates) {
      try {
        await execCode(page, code);
        logger.success(`[Agent] Fast-path (${actionType}) worked`);
        stepStore.set(stepClean, code);
        return { success: true, code, source: 'library', error: null };
      } catch (err) {
        if (actionType === 'hardWait' && /closed|detached/i.test(err.message)) {
          return { success: true, code, source: 'library', error: null };
        }
        logger.warning(`[Agent] Fast-path failed: ${summarizeExecError(err)}`);
      }
    }
  }

  // Capture page elements
  let hybridData = [];
  try {
    hybridData = await captureHybridInputData(page, null, stepClean);
  } catch (err) {
    logger.warning(`[Agent] Element capture failed: ${err.message}`);
  }

  const focusedElements = filterRelevantElements(hybridData || [], stepClean) || [];

  // Try action library with elements
  const focusedCandidates = tryActionLibrary(stepClean, focusedElements) || [];
  const broadCandidates = focusedElements.length < hybridData.length
    ? (tryActionLibrary(stepClean, hybridData) || [])
    : [];
  const candidates = [...new Set([...focusedCandidates, ...broadCandidates])];

  if (candidates.length > 0) {
    logger.info(`[Agent] Action library: ${candidates.length} candidate(s)`);
    for (let i = 0; i < candidates.length; i++) {
      try {
        await execCode(page, candidates[i]);
        logger.success(`[Agent] Action library candidate ${i + 1} worked`);
        stepStore.set(stepClean, candidates[i]);
        if (causesNavigation(step)) await waitForPageStable(page);
        return { success: true, code: candidates[i], source: 'library', error: null };
      } catch (err) {
        logger.warning(`[Agent] Candidate ${i + 1} failed: ${summarizeExecError(err)}`);
      }
    }
  }

  // 3. LLM code generation fallback
  logger.info(`[Agent] Falling back to LLM for: "${stepClean}"`);
  try {
    const suggestions = await suggestAlternativeLocators(
      page, stepClean,
      '// No existing code — generate from scratch',
      'New step — no existing code',
      null, runDir
    );

    if (suggestions && suggestions.length > 0) {
      for (let i = 0; i < suggestions.length; i++) {
        const raw = suggestions[i];
        const code = typeof raw === 'string' ? raw : raw?.code;
        if (!code) continue;
        try {
          await execCode(page, code);
          logger.success(`[Agent] LLM suggestion ${i + 1} worked`);
          stepStore.set(stepClean, code);
          if (causesNavigation(step)) await waitForPageStable(page);
          return { success: true, code, source: 'llm', error: null };
        } catch (err) {
          logger.warning(`[Agent] LLM suggestion ${i + 1} failed: ${summarizeExecError(err)}`);
        }
      }
    }
  } catch (err) {
    logger.error(`[Agent] LLM error: ${err.message}`);
  }

  return { success: false, code: null, source: 'none', error: `All resolution methods failed for: ${stepClean}` };
}

/**
 * Capture validation error messages that are ACTUALLY VISIBLE on the page.
 * Uses getBoundingClientRect + getComputedStyle to filter out hidden DOM elements.
 */
async function captureValidationErrors(page) {
  try {
    return await page.evaluate(() => {
      const errors = [];

      function isActuallyVisible(el) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        // Must be within viewport (roughly)
        if (rect.top > window.innerHeight || rect.bottom < 0) return false;
        // Check parent visibility too (one level up)
        const parent = el.parentElement;
        if (parent) {
          const ps = window.getComputedStyle(parent);
          if (ps.display === 'none' || ps.visibility === 'hidden' || ps.opacity === '0') return false;
        }
        return true;
      }

      // Look for elements that look like error messages
      const candidates = document.querySelectorAll(
        '[class*="error"], [class*="invalid"], [aria-invalid="true"], ' +
        '[class*="validation"], [role="alert"]'
      );

      // Words that indicate tab headers / nav labels, NOT errors
      const tabPatterns = /^(details|notes|attachments|equipment|overview|summary|settings|profile|history|schedule|general|advanced|info|preferences|billing|notifications)$/i;
      const navTagNames = new Set(['NAV', 'LI', 'A']);

      for (const el of candidates) {
        if (!isActuallyVisible(el)) continue;
        // Skip tab/nav elements
        if (navTagNames.has(el.tagName)) continue;
        if (el.getAttribute('role') === 'tab' || el.getAttribute('role') === 'tablist') continue;
        if (el.closest('[role="tablist"], [role="navigation"], nav')) continue;

        const text = (el.textContent || '').trim();
        // Skip generic containers — only keep short, meaningful error text
        if (text && text.length > 3 && text.length < 150 && !errors.includes(text)) {
          // Avoid picking up large container text by checking element's own text vs children
          const ownText = Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent.trim())
            .join(' ').trim();
          const msg = ownText.length > 3 ? ownText : text;
          // Skip messages that look like tab headers (just a few words, no error keywords)
          if (tabPatterns.test(msg.trim())) continue;
          // Skip if all words look like tab labels (multi-word tab strip: "Details Notes Attachments")
          const words = msg.trim().split(/\s+/);
          if (words.length >= 2 && words.every(w => tabPatterns.test(w))) continue;
          // Must contain error-like language OR be from a clear error container
          const hasErrorSignal = /error|invalid|required|fail|missing|incorrect|wrong|must|cannot|can't|please/i.test(msg)
            || el.getAttribute('role') === 'alert'
            || /error|invalid|validation/i.test(el.className || '');
          if (!hasErrorSignal) continue;

          if (msg.length < 150 && !errors.includes(msg)) {
            errors.push(msg);
          }
        }
      }
      return errors.slice(0, 8);
    });
  } catch (_) {
    return [];
  }
}

/**
 * Detect if the agent is stuck in a loop.
 *
 * Two strategies:
 *   A) Submit-cycle detection: if we've clicked submit/continue on the same URL
 *      more than `maxSubmitsPerUrl` times, we're looping.
 *   B) Action-verb pattern: if the last N steps are all fills on the same URL
 *      and we've already done a full fill+submit cycle before.
 */
function detectLoop(recordedSteps, windowSize, submitTracker, currentUrl) {
  if (recordedSteps.length < 6) return false;

  // Strategy A: same-URL submit count (3+ failed submits on CURRENT URL = loop)
  if (submitTracker && currentUrl && submitTracker[currentUrl] >= 3) {
    return true;
  }

  // Strategy B: exact step-sequence repeat (original approach)
  if (recordedSteps.length >= windowSize) {
    const recent = recordedSteps.slice(-windowSize).map(s => s.step.toLowerCase().trim());
    const half = Math.floor(windowSize / 2);
    const firstHalf = recent.slice(0, half).join('|');
    const secondHalf = recent.slice(half, half * 2).join('|');
    if (firstHalf === secondHalf) return true;
  }

  // Strategy C: action-verb pattern — mostly fills AND we have failed submits on CURRENT URL
  if (submitTracker && currentUrl && recordedSteps.length >= 8) {
    const failedSubmitsOnThisUrl = submitTracker[currentUrl] || 0;
    if (failedSubmitsOnThisUrl >= 1) {
      const last8 = recordedSteps.slice(-8);
      const fills = last8.filter(s => /^fill\b/i.test(s.step));
      if (fills.length >= 6) return true;
    }
  }

  return false;
}

/**
 * Check if a step was already executed recently (within the last N steps).
 * For fill steps, also checks if the same FIELD was filled (ignoring value).
 */
function isRepeatedStep(step, recordedSteps, lookback, contextChanged) {
  // If the page context significantly changed (new form section opened), skip repeat detection
  if (contextChanged) return false;

  const normalized = step.toLowerCase().trim();
  const recent = recordedSteps.slice(-lookback);

  // Exact match
  if (recent.some(s => s.step.toLowerCase().trim() === normalized)) return true;

  // For fill steps, check if the same field was already filled (different value is still a repeat)
  // But skip if the step has a qualifier like "in the address form" suggesting a different context
  const fillMatch = normalized.match(/^fill\s+(.+?)\s+as\s+/i);
  if (fillMatch) {
    const fieldName = fillMatch[1].toLowerCase();
    // If the step has extra context ("in the...", "for...", "service address"), it's likely a different field
    if (/\b(in the|for|service|address|billing|mailing|shipping|secondary)\b/i.test(step)) return false;
    return recent.some(s => {
      const m = s.step.toLowerCase().match(/^fill\s+(.+?)\s+as\s+/i);
      return m && m[1].toLowerCase() === fieldName;
    });
  }

  return false;
}

/**
 * Strip surrounding quotes from fill values in step text.
 * "fill First Name as \"TestUser\"" → "fill First Name as TestUser"
 */
function stripQuotesFromStep(step) {
  // Strip quotes from fill/enter values: fill X as "Y" → fill X as Y
  return step
    .replace(/^((?:fill|set)\s+.+?\s+(?:as|with)\s+)["'](.+?)["']$/i, '$1$2')
    .replace(/^((?:enter|type|input)\s+)["'](.+?)["'](\s+(?:in\s*to|in|to)\s+.+)$/i, '$1$2$3');
}

/**
 * Extract the URL from the agent goal prompt.
 * e.g. "On https://example.com perform a booking" → "https://example.com"
 */
function extractUrlFromGoal(goal) {
  const urlMatch = goal.match(/https?:\/\/[^\s,]+/i);
  return urlMatch ? urlMatch[0] : null;
}

/**
 * Run the QA Agent.
 *
 * @param {string} goal - High-level goal, e.g. "On https://example.com perform a booking"
 * @param {Object} options - { testName, maxSteps, headless }
 * @returns {Promise<Object>} Agent run results
 */
async function runAgent(goal, options = {}) {
  const testName = options.testName || 'agent-test';
  const maxSteps = options.maxSteps || MAX_STEPS;
  const previousPaths = options.previousPaths || [];
  const startTime = Date.now();

  // If previous exploration paths exist, augment the goal so the planner tries new paths
  let augmentedGoal = goal;
  if (previousPaths.length > 0) {
    const pathSummary = previousPaths.map((p, i) => `  Pass ${i + 1}: ${p}`).join('\n');
    augmentedGoal = `${goal}\n\nIMPORTANT: Previous exploration passes already covered these paths. You MUST explore a DIFFERENT flow or path this time:\n${pathSummary}\nTry clicking different links, navigating to different sections, or testing different features.`;
  }

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`QA AGENT STARTED`);
  logger.info(`Goal: ${goal}`);
  logger.info(`Test name: ${testName}`);
  logger.info(`Max steps: ${maxSteps}`);
  if (previousPaths.length > 0) logger.info(`Previous paths: ${previousPaths.length}`);
  logger.info(`${'═'.repeat(60)}\n`);

  // Extract URL from goal
  const startUrl = extractUrlFromGoal(goal);
  if (!startUrl) {
    logger.error('[Agent] No URL found in goal. Include a URL like: "On https://example.com perform a booking"');
    return { success: false, error: 'No URL in goal' };
  }

  // Launch browser
  const browser = await launchBrowser();
  const context = await browser.newContext(getDefaultContextOptions());
  const page = await newPage(context);

  const recordedSteps = [];
  let consecutiveFailures = 0;
  let totalLLMCalls = 0;
  let goalDone = false;
  let goalStuck = false;
  let previousUrl = '';
  let previousElementCount = 0;  // track element count to detect form section expansions
  const submitTracker = {};  // { url: submitCount } — tracks how many times we submitted on each URL

  try {
    // Step 0: Navigate to the URL
    const navStep = `open ${startUrl}`;
    logger.info(`[Agent] Step 0: ${navStep}`);
    const navResult = await executeAgentStep(page, navStep, null);
    recordedSteps.push({ step: navStep, ...navResult });
    if (!navResult.success) {
      logger.error(`[Agent] Failed to navigate to ${startUrl}`);
      return { success: false, error: 'Navigation failed' };
    }

    // Wait for initial page load
    await waitForPageStable(page);

    // Agent loop
    for (let stepNum = 1; stepNum <= maxSteps; stepNum++) {
      logger.info(`\n${'─'.repeat(40)} Step ${stepNum} ${'─'.repeat(40)}`);

      // Capture current page state for the planner
      let elements = [];
      try {
        elements = await captureHybridInputData(page, null, 'analyze page');
      } catch (err) {
        logger.warning(`[Agent] Element capture for planner failed: ${err.message}`);
      }

      const currentUrl = page.url();
      const currentElementCount = elements.length;
      // Detect if page context significantly changed (new form section expanded, modal opened, etc.)
      const contextChanged = previousElementCount > 0 && Math.abs(currentElementCount - previousElementCount) > 15;
      if (contextChanged) {
        logger.info(`[Agent] Page context changed (elements: ${previousElementCount} → ${currentElementCount})`);
      }
      previousElementCount = currentElementCount;

      // Detect validation errors on the page
      const validationErrors = await captureValidationErrors(page);
      if (validationErrors.length > 0) {
        logger.warning(`[Agent] Validation errors detected: ${validationErrors.join(', ')}`);
      }

      // Reset loop warnings when page context changes significantly (new wizard step, modal, etc.)
      if (contextChanged) {
        // Clear old loop warnings — the page progressed
        for (const s of recordedSteps) { s._loopWarned = false; }
        // Clear submit tracker for the previous URL since progress was made
        if (previousUrl && submitTracker[previousUrl]) {
          delete submitTracker[previousUrl];
          logger.info(`[Agent] Submit tracker reset for ${previousUrl} (context changed)`);
        }
      }

      // Detect loops: check submit cycles + step patterns
      const loopDetected = detectLoop(recordedSteps, LOOP_WINDOW, submitTracker, currentUrl);
      if (loopDetected) {
        logger.warning(`[Agent] Loop detected — agent is repeating same actions on same URL`);
        // Give planner TWO chances to break out, then force stop
        const loopAttempts = recordedSteps.filter(s => s._loopWarned).length;
        if (loopAttempts >= 3) {
          logger.error(`[Agent] Loop persisted after 3 warnings — stopping.`);
          goalStuck = true;
          break;
        }
      }

      // Build submit count info for planner
      const submitCountOnThisUrl = submitTracker[currentUrl] || 0;

      // Ask planner for next action (with extra context)
      totalLLMCalls++;
      const plan = await planNextAction(augmentedGoal, currentUrl, elements, recordedSteps, stepNum, {
        previousUrl,
        loopDetected,
        validationErrors,
        submitCountOnThisUrl
      });

      if (plan.done) {
        logger.info(`[Agent] 🎯 GOAL COMPLETE after ${stepNum - 1} steps`);
        goalDone = true;
        break;
      }

      if (plan.stuck || !plan.step) {
        logger.warning(`[Agent] Planner is stuck or returned empty step`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error(`[Agent] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping`);
          goalStuck = true;
          break;
        }
        continue;
      }

      // Strip quotes from the step text (LLM may still wrap values in quotes)
      const cleanedStep = stripQuotesFromStep(plan.step);
      if (cleanedStep !== plan.step) {
        logger.info(`[Agent] Cleaned step: "${cleanedStep}"`);
      }

      // If loop detected and planner gave a fill step for a field we already filled, force STUCK
      if (loopDetected && isRepeatedStep(cleanedStep, recordedSteps, 8, contextChanged)) {
        logger.error(`[Agent] Loop confirmed — same field/step repeated after warning. Stopping.`);
        goalStuck = true;
        break;
      }

      // Execute the planned step
      logger.info(`[Agent] Executing: "${cleanedStep}"`);
      previousUrl = currentUrl;
      const result = await executeAgentStep(page, cleanedStep, null);
      if (result.source === 'llm') totalLLMCalls++;

      // Track submit actions per URL
      if (result.success && causesNavigation(cleanedStep)) {
        // Wait a bit extra for SPA redirects before checking URL
        try { await page.waitForTimeout(2000); } catch (_) { }
        const postUrl = page.url();
        if (postUrl === currentUrl) {
          // URL didn't change after submit — count it
          submitTracker[currentUrl] = (submitTracker[currentUrl] || 0) + 1;
          logger.warning(`[Agent] Submit on ${currentUrl} did NOT change URL (count: ${submitTracker[currentUrl]})`);
        } else {
          // URL changed — reset tracker for old URL, this is progress
          logger.info(`[Agent] Page navigated: ${currentUrl} → ${postUrl}`);
          delete submitTracker[currentUrl];
          // Also clear loop warnings — navigation is progress
          for (const s of recordedSteps) { s._loopWarned = false; }
          // Screenshot on page change for visual evidence
          try {
            const ssName = `agent_${testName}_step${stepNum}.png`;
            const ssPath = path.join(__dirname, '../../../reports', ssName);
            await page.screenshot({ path: ssPath, fullPage: false });
            logger.info(`[Agent] Screenshot saved: ${ssName}`);
          } catch (_) { }
        }
      }

      recordedSteps.push({ step: cleanedStep, ...result, _loopWarned: loopDetected });

      if (result.success) {
        logger.success(`[Agent] ✅ Step ${stepNum} passed (${result.source})`);
        consecutiveFailures = 0;
      } else {
        logger.error(`[Agent] ❌ Step ${stepNum} failed: ${result.error}`);
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.error(`[Agent] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — stopping`);
          goalStuck = true;
          break;
        }
      }
    }

    // Take final screenshot
    try {
      const screenshotPath = path.join(__dirname, '../../../reports', `agent_${testName}_final.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      logger.info(`[Agent] Final screenshot: ${screenshotPath}`);
    } catch (_) { }

  } finally {
    await context.close();
    await browser.close();
    resetConversationSession();
  }

  const durationSeconds = (Date.now() - startTime) / 1000;
  const passedSteps = recordedSteps.filter(s => s.success).length;
  const failedSteps = recordedSteps.filter(s => !s.success).length;

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`QA AGENT FINISHED`);
  logger.info(`Goal: ${goalDone ? 'COMPLETE ✅' : goalStuck ? 'STUCK ❌' : 'MAX STEPS REACHED ⚠️'}`);
  logger.info(`Steps: ${passedSteps} passed, ${failedSteps} failed, ${recordedSteps.length} total`);
  logger.info(`Duration: ${durationSeconds.toFixed(1)}s`);
  logger.info(`LLM calls: ${totalLLMCalls}`);
  logger.info(`${'═'.repeat(60)}\n`);

  // Generate .test file (only from successful steps)
  let testFilePath = null;
  if (passedSteps > 0) {
    testFilePath = generateTestFile(testName, recordedSteps);
  }

  // Generate agent report
  const reportPath = generateAgentReport(testName, recordedSteps, {
    goal,
    startUrl,
    durationSeconds,
    totalLLMCalls
  });

  return {
    success: goalDone,
    goalDone,
    goalStuck,
    testFilePath,
    reportPath,
    steps: recordedSteps,
    duration: durationSeconds,
    totalLLMCalls
  };
}

/**
 * Parse a comprehensive QA prompt into structured test configuration
 */
function parseComprehensivePrompt(promptText) {
  const config = {
    objective: '',
    appContext: {},
    personas: [],
    journeys: [],
    testingExpectations: [],
    browsers: [],
    credentials: {},
    specialInstructions: []
  };

  // Extract objective
  const objectiveSection = promptText.match(/## Objective[\s\S]*?(?=##|$)/i);
  if (objectiveSection) {
    // Get the text after the heading, trimmed, excluding bullet points preamble
    const objText = objectiveSection[0].replace(/^## Objective\s*/i, '').trim();
    // Collapse multi-line objective into single string
    config.objective = objText.split('\n').map(l => l.replace(/^\*\s*/, '').trim()).filter(Boolean).join('; ');
  }

  // Extract application context
  const appMatch = promptText.match(/Application Name:\s*(.+)/i);
  if (appMatch) config.appContext.name = appMatch[1].trim();

  const envMatch = promptText.match(/Environment:\s*(.+)/i);
  if (envMatch) config.appContext.environment = envMatch[1].trim();

  const urlMatch = promptText.match(/(?:Prod Customer Portal|URL):\s*(https?:\/\/[^\s]+)/i);
  if (urlMatch) config.appContext.url = urlMatch[1].trim();

  // Extract credentials
  const emailMatch = promptText.match(/email\s*=\s*([^\s,]+)/i);
  if (emailMatch) config.credentials.email = emailMatch[1].trim();

  const passwordMatch = promptText.match(/password\s*=\s*([^\s,]+)/i);
  if (passwordMatch) config.credentials.password = passwordMatch[1].trim();

  // Extract personas
  const personaSection = promptText.match(/## User Personas[\s\S]*?(?=##|$)/i);
  if (personaSection) {
    const personaLines = personaSection[0].match(/^\d+\.\s*(.+)$/gm);
    if (personaLines) {
      config.personas = personaLines.map(line => {
        const match = line.match(/^\d+\.\s*(.+)$/);
        return match ? match[1].trim() : line.trim();
      });
    }
  }

  // Extract critical journeys
  const journeySection = promptText.match(/## Critical User Journeys[\s\S]*?(?=\n#{1,3} |$)/i);
  if (journeySection) {
    const journeyLines = journeySection[0].match(/^\*\s*(.+)$/gm);
    if (journeyLines) {
      config.journeys = journeyLines.map(line => {
        const match = line.match(/^\*\s*(.+)$/);
        return match ? match[1].trim() : line.trim();
      });
    }
  }

  // Extract special instructions
  const specialSection = promptText.match(/# Special and critical Instructions[\s\S]*?(?=\n#{1,3} |$)/i);
  if (specialSection) {
    const instructionLines = specialSection[0].match(/^\*\s*(.+)$/gm);
    if (instructionLines) {
      config.specialInstructions = instructionLines.map(line => {
        const match = line.match(/^\*\s*(.+)$/);
        return match ? match[1].trim() : line.trim();
      });
    }
  }

  // Extract testing expectations
  const expectationSections = [
    'Functional Validation',
    'UX Validation',
    'Visual Validation',
    'Accessibility',
    'Performance Perception',
    'Edge Cases'
  ];

  for (const section of expectationSections) {
    const regex = new RegExp(`### ${section}[\\s\\S]*?(?=###|##|$)`, 'i');
    const match = promptText.match(regex);
    if (match) {
      config.testingExpectations.push({
        category: section,
        checks: match[0].match(/^\*\s*(.+)$/gm)?.map(l => l.replace(/^\*\s*/, '').trim()) || []
      });
    }
  }

  // Extract browser/device requirements
  const browserSection = promptText.match(/## Browser \/ Device Coverage[\s\S]*?(?=##|$)/i);
  if (browserSection) {
    const browserLines = browserSection[0].match(/^\*\s*(.+)$/gm);
    if (browserLines) {
      config.browsers = browserLines.map(line => {
        const match = line.match(/^\*\s*(.+)$/);
        return match ? match[1].trim() : line.trim();
      });
    }
  }

  // ── Fallbacks for minimal prompts ──

  // If no journeys found, derive from the objective
  if (config.journeys.length === 0 && config.objective) {
    logger.info(`[ComprehensiveQA] No explicit journeys found — using objective as journey`);
    // Split objective on semicolons (from our earlier collapsing) to get individual tasks
    const parts = config.objective.split(/;\s*/).filter(Boolean);
    config.journeys = parts.length > 0 ? parts : [config.objective];
  }

  // If no personas found but credentials exist, create a default persona
  if (config.personas.length === 0 && config.credentials.email) {
    config.personas = [`Default user (${config.credentials.email})`];
  }

  return config;
}

/**
 * Issue tracker for comprehensive testing
 */
class IssueTracker {
  constructor() {
    this.issues = [];
    this.screenshots = [];
  }

  addIssue(issue) {
    this.issues.push({
      id: this.issues.length + 1,
      timestamp: new Date().toISOString(),
      ...issue
    });
  }

  addScreenshot(screenshotPath, context) {
    this.screenshots.push({
      path: screenshotPath,
      context,
      timestamp: new Date().toISOString()
    });
  }

  getIssuesBySeverity(severity) {
    return this.issues.filter(i => i.severity === severity);
  }

  getCriticalIssues() {
    return this.issues.filter(i => i.severity === 'Critical' || i.severity === 'High');
  }
}

/**
 * Detect various issues on the current page
 */
async function detectPageIssues(page, issueTracker, journey, stepNum) {
  try {
    const visualIssues = await page.evaluate(() => {
      const issues = [];

      // Check for overlapping elements
      const elements = document.querySelectorAll('button, a, input, select');
      for (let i = 0; i < elements.length; i++) {
        const rect1 = elements[i].getBoundingClientRect();
        if (rect1.width === 0 || rect1.height === 0) continue;

        for (let j = i + 1; j < elements.length; j++) {
          const rect2 = elements[j].getBoundingClientRect();
          if (rect2.width === 0 || rect2.height === 0) continue;

          if (!(rect1.right < rect2.left ||
            rect1.left > rect2.right ||
            rect1.bottom < rect2.top ||
            rect1.top > rect2.bottom)) {
            issues.push({
              type: 'visual',
              message: 'Overlapping interactive elements detected',
              element1: elements[i].tagName + (elements[i].textContent ? ': ' + elements[i].textContent.substring(0, 30) : ''),
              element2: elements[j].tagName + (elements[j].textContent ? ': ' + elements[j].textContent.substring(0, 30) : '')
            });
          }
        }
      }

      // Check for missing alt text on images
      const images = document.querySelectorAll('img');
      images.forEach(img => {
        if (!img.alt && img.offsetWidth > 0 && img.offsetHeight > 0) {
          issues.push({
            type: 'accessibility',
            message: 'Image missing alt text',
            src: img.src
          });
        }
      });

      // Check for buttons without accessible names
      const buttons = document.querySelectorAll('button, [role="button"]');
      buttons.forEach(btn => {
        const hasText = btn.textContent.trim().length > 0;
        const hasAriaLabel = btn.getAttribute('aria-label');
        const hasTitle = btn.getAttribute('title');

        if (!hasText && !hasAriaLabel && !hasTitle) {
          issues.push({
            type: 'accessibility',
            message: 'Button without accessible name',
            html: btn.outerHTML.substring(0, 100)
          });
        }
      });

      return issues;
    });

    for (const issue of visualIssues) {
      issueTracker.addIssue({
        severity: issue.type === 'accessibility' ? 'Medium' : 'Low',
        area: journey,
        page: page.url(),
        stepsToReproduce: `Navigate to page and observe at step ${stepNum}`,
        expectedResult: issue.type === 'accessibility' ? 'All elements should be accessible' : 'No visual overlaps',
        actualResult: issue.message,
        screenshot: null,
        recommendation: issue.type === 'accessibility' ? 'Add proper ARIA labels and alt text' : 'Fix CSS layout'
      });
    }
  } catch (err) {
    logger.warning(`[IssueDetection] Failed: ${err.message}`);
  }
}

/**
 * Monitor console errors
 */
async function detectConsoleErrors(page, issueTracker, journey) {
  try {
    const errorMessages = await page.evaluate(() => {
      const errors = [];
      const errorElements = document.querySelectorAll('[class*="error"], [role="alert"]');
      errorElements.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 0 && text.length < 200) {
          errors.push(text);
        }
      });
      return errors;
    });

    if (errorMessages.length > 0) {
      issueTracker.addIssue({
        severity: 'Medium',
        area: journey,
        page: page.url(),
        stepsToReproduce: 'Navigate to page',
        expectedResult: 'No error messages displayed',
        actualResult: `Error messages found: ${errorMessages.join(', ')}`,
        screenshot: null,
        recommendation: 'Investigate and fix validation or system errors'
      });
    }
  } catch (err) {
    logger.warning(`[ErrorDetection] Failed: ${err.message}`);
  }
}

/**
 * Execute a single user journey with comprehensive validation
 */
async function executeJourney(page, journey, config, issueTracker, journeyIndex) {
  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`JOURNEY ${journeyIndex + 1}: ${journey}`);
  logger.info(`${'═'.repeat(60)}\n`);

  const steps = [];
  const startTime = Date.now();
  let goalDone = false;
  let goalStuck = false;

  try {
    // Build journey-specific goal with context
    let goal = `On ${config.appContext.url} execute this user journey: ${journey}`;

    if (config.credentials.email && config.credentials.password) {
      goal += `\n\nCredentials:\n- Email: ${config.credentials.email}\n- Password: ${config.credentials.password}`;
    }

    if (config.specialInstructions.length > 0) {
      goal += `\n\nCRITICAL INSTRUCTIONS:\n${config.specialInstructions.map(i => `- ${i}`).join('\n')}`;
    }

    // Navigate to start URL
    const navStep = `open ${config.appContext.url}`;
    logger.info(`[Journey] Step 0: ${navStep}`);
    await page.goto(config.appContext.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForPageStable(page);
    steps.push({ step: navStep, success: true, source: 'direct' });

    // Take initial screenshot
    const fs = require('fs');
    const screenshotDir = path.join(__dirname, '../../../reports/screenshots');
    if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

    const initialScreenshot = path.join(screenshotDir, `journey${journeyIndex + 1}_step0_initial.png`);
    await page.screenshot({ path: initialScreenshot, fullPage: true });
    issueTracker.addScreenshot(initialScreenshot, `Journey ${journeyIndex + 1} - Initial state`);

    // Execute journey steps using the planner
    const MAX_JOURNEY_STEPS = 50;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;
    const failedSteps = new Map(); // Track failed steps and their attempts
    
    for (let stepNum = 1; stepNum <= MAX_JOURNEY_STEPS; stepNum++) {
      logger.info(`\n${'─'.repeat(40)} Step ${stepNum} ${'─'.repeat(40)}`);

      let elements = [];
      try {
        elements = await captureHybridInputData(page, null, 'analyze page');
      } catch (err) {
        logger.warning(`[Journey] Element capture failed: ${err.message}`);
      }

      const currentUrl = page.url();

      // Detect issues on current page
      await detectPageIssues(page, issueTracker, journey, stepNum);

      // Build context for intelligent recovery
      const recentFailures = steps.slice(-5).filter(s => !s.success);
      const hasRepeatedFailures = consecutiveFailures >= 2;
      
      // Ask planner for next action with failure context
      const plan = await planNextAction(goal, currentUrl, elements, steps, stepNum, {
        consecutiveFailures,
        recentFailures: recentFailures.map(f => ({ step: f.step, error: f.error })),
        hasRepeatedFailures
      });

      if (plan.done) {
        logger.info(`[Journey] ✅ Journey complete after ${stepNum - 1} steps`);
        goalDone = true;
        break;
      }

      if (plan.stuck || !plan.step) {
        logger.warning(`[Journey] Planner stuck or no step returned`);
        goalStuck = true;
        break;
      }

      // Check if this step has failed before
      const stepKey = plan.step.toLowerCase().trim();
      const previousAttempts = failedSteps.get(stepKey) || 0;
      let originalStep = null;
      let recoveryAttempt = false;
      
      // If step failed 2+ times, ask planner for alternative approach
      if (previousAttempts >= 2) {
        logger.warning(`[Journey] Step "${plan.step}" has failed ${previousAttempts} times. Requesting alternative approach...`);
        originalStep = plan.step; // Save original step for recording
        recoveryAttempt = true;
        
        const alternativePlan = await planNextAction(
          goal + `\n\nIMPORTANT: The step "${plan.step}" has failed ${previousAttempts} times. Try a COMPLETELY DIFFERENT approach to achieve the same goal. Consider: clicking different elements, using keyboard navigation, or breaking it into smaller steps.`,
          currentUrl,
          elements,
          steps,
          stepNum,
          { requestingAlternative: true, failedStep: plan.step }
        );
        
        if (alternativePlan.step && alternativePlan.step !== plan.step) {
          logger.info(`[Journey] Trying alternative: "${alternativePlan.step}"`);
          plan.step = alternativePlan.step;
          failedSteps.delete(stepKey); // Reset counter for new approach
        }
      }

      // Execute step
      logger.info(`[Journey] Executing: "${plan.step}"`);
      const result = await executeAgentStep(page, plan.step, null);
      
      // Enhanced step recording with recovery metadata
      const stepRecord = { 
        step: plan.step, 
        ...result,
        recoveryAttempt,
        originalStep,
        attemptNumber: previousAttempts + 1
      };
      
      // Add recovery note if this was an alternative approach
      if (recoveryAttempt && originalStep) {
        stepRecord.recoveryNote = `Alternative approach after ${previousAttempts} failed attempts of: "${originalStep}"`;
        logger.info(`[Journey] 🔄 Recovery: ${stepRecord.recoveryNote}`);
      }
      
      steps.push(stepRecord);

      if (result.success) {
        logger.success(`[Journey] ✅ Step ${stepNum} passed`);
        consecutiveFailures = 0;
        failedSteps.delete(stepKey); // Clear failure tracking on success
        
        // Log successful recovery
        if (recoveryAttempt && originalStep) {
          logger.success(`[Journey] 🎯 Recovery successful! Alternative approach worked.`);
          issueTracker.addIssue({
            severity: 'Medium',
            area: journey,
            page: currentUrl,
            stepsToReproduce: `Original step failed ${previousAttempts} times: "${originalStep}"\nSuccessful alternative: "${plan.step}"`,
            expectedResult: `Step should work: ${originalStep}`,
            actualResult: `Original approach failed, but alternative approach succeeded`,
            screenshot: null,
            recommendation: `Consider updating test to use: "${plan.step}" instead of "${originalStep}"`
          });
        }

        if (/click|submit|continue|login|save/i.test(plan.step)) {
          const screenshot = path.join(screenshotDir, `journey${journeyIndex + 1}_step${stepNum}.png`);
          await page.screenshot({ path: screenshot, fullPage: false });
          issueTracker.addScreenshot(screenshot, `Journey ${journeyIndex + 1} - Step ${stepNum}: ${plan.step}`);
        }
      } else {
        logger.error(`[Journey] ❌ Step ${stepNum} failed: ${result.error}`);
        consecutiveFailures++;
        failedSteps.set(stepKey, previousAttempts + 1);

        const failureScreenshot = path.join(screenshotDir, `journey${journeyIndex + 1}_step${stepNum}_FAILURE.png`);
        await page.screenshot({ path: failureScreenshot, fullPage: true });

        issueTracker.addIssue({
          severity: consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'Critical' : 'High',
          area: journey,
          page: currentUrl,
          stepsToReproduce: steps.map(s => {
            if (s.recoveryNote) {
              return `${s.step} (${s.recoveryNote})`;
            }
            return s.step;
          }).join('\n'),
          expectedResult: `Step should execute successfully: ${plan.step}`,
          actualResult: `Step failed (attempt ${previousAttempts + 1}): ${result.error}`,
          screenshot: failureScreenshot,
          recommendation: consecutiveFailures >= 2 
            ? 'Multiple consecutive failures - may indicate blocking issue or incorrect approach'
            : 'Investigate element locators and page state'
        });
        
        // After MAX_CONSECUTIVE_FAILURES, ask planner if we should skip this part
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          logger.warning(`[Journey] ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Asking planner to skip or find workaround...`);
          
          const recoveryPlan = await planNextAction(
            goal + `\n\nCRITICAL: The last ${MAX_CONSECUTIVE_FAILURES} steps have failed. This part of the journey may be broken or blocked. Either: (1) Skip this section and continue with the next logical step, (2) Try a completely different path to achieve the goal, or (3) Output GOAL_STUCK if this is essential and cannot be bypassed.`,
            currentUrl,
            elements,
            steps,
            stepNum,
            { criticalFailure: true, consecutiveFailures }
          );
          
          if (recoveryPlan.stuck) {
            logger.error(`[Journey] Unable to recover from failures. Marking journey as stuck.`);
            goalStuck = true;
            break;
          }
          
          if (recoveryPlan.step) {
            logger.info(`[Journey] Recovery plan: "${recoveryPlan.step}"`);
            
            // Record the recovery decision
            steps.push({
              step: recoveryPlan.step,
              success: null, // Will be determined in next iteration
              source: 'recovery',
              recoveryAttempt: true,
              recoveryNote: `Critical recovery after ${consecutiveFailures} consecutive failures`,
              attemptNumber: 1
            });
            
            consecutiveFailures = 0; // Reset counter when trying recovery
          }
        }
      }

      await detectConsoleErrors(page, issueTracker, journey);
    }

    // Take final screenshot
    const finalScreenshot = path.join(screenshotDir, `journey${journeyIndex + 1}_final.png`);
    await page.screenshot({ path: finalScreenshot, fullPage: true });
    issueTracker.addScreenshot(finalScreenshot, `Journey ${journeyIndex + 1} - Final state`);

  } catch (error) {
    logger.error(`[Journey] Error: ${error.message}`);
    issueTracker.addIssue({
      severity: 'Critical',
      area: journey,
      page: page.url(),
      stepsToReproduce: steps.map(s => s.step).join('\n'),
      expectedResult: 'Journey should complete without errors',
      actualResult: `Journey crashed: ${error.message}`,
      screenshot: null,
      recommendation: 'Critical error - requires immediate investigation'
    });
  }

  const duration = (Date.now() - startTime) / 1000;
  const passedSteps = steps.filter(s => s.success).length;

  // Generate .test file from successful steps
  let testFilePath = null;
  if (passedSteps > 0) {
    // Build a test name from app name + journey description
    const appPrefix = (config.appContext.name || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const journeySuffix = journey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 40);
    const testName = `${appPrefix}-${String(journeyIndex + 1).padStart(2, '0')}-${journeySuffix}`;
    testFilePath = generateTestFile(testName, steps, {
      tags: ['@smoke', '@comprehensive-qa', `@journey-${journeyIndex + 1}`]
    });
    logger.info(`[Journey] Test file generated: ${testFilePath}`);
  }

  return {
    journey,
    goalDone,
    goalStuck,
    steps,
    passedSteps,
    totalSteps: steps.length,
    duration,
    testFilePath
  };
}

/**
 * Generate comprehensive QA report
 */
function generateComprehensiveReport(config, journeyResults, issueTracker, totalDuration) {
  const fs = require('fs');
  const reportsDir = path.join(__dirname, '../../../reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `comprehensive_qa_${timestamp}.md`);

  let md = `# Comprehensive QA Report\n\n`;
  md += `**Application:** ${config.appContext.name || 'N/A'}\n`;
  md += `**Environment:** ${config.appContext.environment || 'N/A'}\n`;
  md += `**URL:** ${config.appContext.url || 'N/A'}\n`;
  md += `**Test Date:** ${new Date().toLocaleString()}\n`;
  md += `**Total Duration:** ${totalDuration.toFixed(1)}s\n\n`;

  // Executive Summary
  md += `## Executive Summary\n\n`;
  const totalIssues = issueTracker.issues.length;
  const criticalIssues = issueTracker.getIssuesBySeverity('Critical').length;
  const highIssues = issueTracker.getIssuesBySeverity('High').length;
  const mediumIssues = issueTracker.getIssuesBySeverity('Medium').length;
  const lowIssues = issueTracker.getIssuesBySeverity('Low').length;

  md += `- **Total Issues Found:** ${totalIssues}\n`;
  md += `- **Critical:** ${criticalIssues}\n`;
  md += `- **High:** ${highIssues}\n`;
  md += `- **Medium:** ${mediumIssues}\n`;
  md += `- **Low:** ${lowIssues}\n\n`;

  const uxScore = Math.max(0, 10 - (criticalIssues * 3) - (highIssues * 2) - (mediumIssues * 0.5));
  md += `**Overall UX Score:** ${uxScore.toFixed(1)}/10\n\n`;

  // Journey Results
  md += `## Journey Execution Results\n\n`;
  md += `| # | Journey | Status | Steps | Recoveries | Duration |\n`;
  md += `|---|---------|--------|-------|------------|----------|\n`;

  for (let i = 0; i < journeyResults.length; i++) {
    const r = journeyResults[i];
    const status = r.goalDone ? '✅ Complete' : r.goalStuck ? '⚠️ Stuck' : '⏱️ Max Steps';
    const recoveries = r.steps ? r.steps.filter(s => s.recoveryAttempt).length : 0;
    const recoveryNote = recoveries > 0 ? `🔄 ${recoveries}` : '-';
    md += `| ${i + 1} | ${r.journey} | ${status} | ${r.passedSteps}/${r.totalSteps} | ${recoveryNote} | ${r.duration.toFixed(1)}s |\n`;
  }
  md += `\n`;
  
  // Recovery Summary
  const totalRecoveries = journeyResults.reduce((sum, r) => {
    return sum + (r.steps ? r.steps.filter(s => s.recoveryAttempt && s.success).length : 0);
  }, 0);
  
  if (totalRecoveries > 0) {
    md += `### Intelligent Recovery Summary\n\n`;
    md += `The agent successfully recovered from failures ${totalRecoveries} time(s) by trying alternative approaches.\n\n`;
    
    // List successful recoveries
    md += `**Successful Recovery Examples:**\n\n`;
    let recoveryCount = 0;
    for (const result of journeyResults) {
      if (!result.steps) continue;
      for (const step of result.steps) {
        if (step.recoveryAttempt && step.success && step.recoveryNote) {
          recoveryCount++;
          md += `${recoveryCount}. **${result.journey}**\n`;
          md += `   - ${step.recoveryNote}\n`;
          md += `   - ✅ Successful alternative: "${step.step}"\n\n`;
          if (recoveryCount >= 5) break; // Show max 5 examples
        }
      }
      if (recoveryCount >= 5) break;
    }
  }

  // Top Issues
  const topIssues = issueTracker.getCriticalIssues().slice(0, 5);
  if (topIssues.length > 0) {
    md += `## Top 5 Critical Issues\n\n`;
    for (let i = 0; i < topIssues.length; i++) {
      const issue = topIssues[i];
      md += `### ${i + 1}. ${issue.area}\n\n`;
      md += `- **Severity:** ${issue.severity}\n`;
      md += `- **Page:** ${issue.page}\n`;
      md += `- **Expected:** ${issue.expectedResult}\n`;
      md += `- **Actual:** ${issue.actualResult}\n`;
      md += `- **Recommendation:** ${issue.recommendation}\n`;
      if (issue.screenshot) {
        md += `- **Screenshot:** \`${path.basename(issue.screenshot)}\`\n`;
      }
      md += `\n`;
    }
  }

  // All Issues by Severity
  md += `## All Issues\n\n`;
  for (const severity of ['Critical', 'High', 'Medium', 'Low']) {
    const issues = issueTracker.getIssuesBySeverity(severity);
    if (issues.length > 0) {
      md += `### ${severity} Severity (${issues.length})\n\n`;
      for (const issue of issues) {
        md += `#### Issue #${issue.id}: ${issue.area}\n\n`;
        md += `- **Page:** ${issue.page}\n`;
        md += `- **Expected:** ${issue.expectedResult}\n`;
        md += `- **Actual:** ${issue.actualResult}\n`;
        md += `- **Recommendation:** ${issue.recommendation}\n`;
        if (issue.screenshot) {
          md += `- **Screenshot:** \`${path.basename(issue.screenshot)}\`\n`;
        }
        md += `\n`;
      }
    }
  }

  // Production Readiness Assessment
  md += `## Production Readiness Assessment\n\n`;
  if (criticalIssues > 0) {
    md += `❌ **NOT READY** - ${criticalIssues} critical issue(s) must be resolved before production deployment.\n\n`;
  } else if (highIssues > 3) {
    md += `⚠️ **CAUTION** - ${highIssues} high-severity issues detected. Recommend fixing before production.\n\n`;
  } else {
    md += `✅ **READY** - No critical issues detected. Minor issues can be addressed in future iterations.\n\n`;
  }

  // Quick Wins
  md += `## Quick Wins for Improvement\n\n`;
  const accessibilityIssues = issueTracker.issues.filter(i => i.actualResult.includes('accessibility') || i.actualResult.includes('alt text') || i.actualResult.includes('accessible name'));
  if (accessibilityIssues.length > 0) {
    md += `1. **Accessibility:** Add missing alt text and ARIA labels (${accessibilityIssues.length} instances)\n`;
  }
  const visualIssues = issueTracker.issues.filter(i => i.actualResult.includes('overlap') || i.actualResult.includes('visual'));
  if (visualIssues.length > 0) {
    md += `2. **Visual:** Fix overlapping elements and layout issues (${visualIssues.length} instances)\n`;
  }
  const errorIssues = issueTracker.issues.filter(i => i.actualResult.includes('error message') || i.actualResult.includes('validation'));
  if (errorIssues.length > 0) {
    md += `3. **UX:** Improve error messaging and validation feedback (${errorIssues.length} instances)\n`;
  }
  md += `\n`;

  // Detailed Journey Steps (with recovery information)
  md += `## Detailed Journey Steps\n\n`;
  for (let i = 0; i < journeyResults.length; i++) {
    const result = journeyResults[i];
    if (!result.steps || result.steps.length === 0) continue;
    
    md += `### Journey ${i + 1}: ${result.journey}\n\n`;
    md += `| Step | Action | Status | Details |\n`;
    md += `|------|--------|--------|----------|\n`;
    
    for (let j = 0; j < result.steps.length; j++) {
      const step = result.steps[j];
      const stepNum = j + 1;
      const status = step.success ? '✅' : '❌';
      const source = step.source || '-';
      
      let details = `Source: ${source}`;
      if (step.recoveryAttempt && step.recoveryNote) {
        details = `🔄 ${step.recoveryNote}`;
      } else if (step.attemptNumber > 1) {
        details = `Attempt ${step.attemptNumber}`;
      }
      
      md += `| ${stepNum} | ${step.step} | ${status} | ${details} |\n`;
    }
    md += `\n`;
  }

  // Generated Test Files
  const testFiles = journeyResults.filter(r => r.testFilePath);
  if (testFiles.length > 0) {
    md += `## Generated Test Files\n\n`;
    md += `The following reusable automation test files were generated from successful journey steps:\n\n`;
    for (let i = 0; i < testFiles.length; i++) {
      const r = testFiles[i];
      md += `${i + 1}. **${r.journey}**: \`${path.basename(r.testFilePath)}\`\n`;
    }
    md += `\nRun any test with: \`node runner.js ${testFiles.length > 0 ? path.basename(testFiles[0].testFilePath, '.test') : '<test-name>'}\`\n\n`;
  }

  // Screenshots
  if (issueTracker.screenshots.length > 0) {
    md += `## Screenshots\n\n`;
    for (const screenshot of issueTracker.screenshots) {
      md += `- **${screenshot.context}**: \`${path.basename(screenshot.path)}\`\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(reportPath, md, 'utf8');
  logger.info(`[ComprehensiveQA] Report saved: ${reportPath}`);
  return reportPath;
}

/**
 * Run comprehensive QA testing based on structured prompt
 */
async function runComprehensiveQA(promptText) {
  const startTime = Date.now();

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`COMPREHENSIVE QA AGENT STARTED`);
  logger.info(`${'═'.repeat(60)}\n`);

  const config = parseComprehensivePrompt(promptText);
  logger.info(`[ComprehensiveQA] Parsed configuration:`);
  logger.info(`  - Application: ${config.appContext.name || '(not specified)'}`);
  logger.info(`  - URL: ${config.appContext.url || '(not found)'}`);
  logger.info(`  - Objective: ${config.objective || '(none)'}`);
  logger.info(`  - Credentials: ${config.credentials.email ? config.credentials.email : '(none)'}`);
  logger.info(`  - Personas: ${config.personas.length}`);
  logger.info(`  - Journeys: ${config.journeys.length}${config.journeys.length > 0 ? ' — ' + config.journeys.join(', ') : ''}`);
  logger.info(`  - Special instructions: ${config.specialInstructions.length}`);
  logger.info(`  - Testing expectations: ${config.testingExpectations.length} categories`);

  if (!config.appContext.url) {
    logger.error('[ComprehensiveQA] No URL found in prompt');
    return { success: false, error: 'No URL in prompt' };
  }

  const issueTracker = new IssueTracker();

  const browser = await launchBrowser();
  const context = await browser.newContext(getDefaultContextOptions());
  const page = await newPage(context);

  const journeyResults = [];

  try {
    for (let i = 0; i < config.journeys.length; i++) {
      const journey = config.journeys[i];
      const result = await executeJourney(page, journey, config, issueTracker, i);
      journeyResults.push(result);
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const totalDuration = (Date.now() - startTime) / 1000;

  const reportPath = generateComprehensiveReport(config, journeyResults, issueTracker, totalDuration);

  // Collect generated test files
  const testFiles = journeyResults.filter(r => r.testFilePath).map(r => r.testFilePath);

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`COMPREHENSIVE QA AGENT FINISHED`);
  logger.info(`Total Duration: ${totalDuration.toFixed(1)}s`);
  logger.info(`Journeys Executed: ${journeyResults.length}`);
  logger.info(`Issues Found: ${issueTracker.issues.length}`);
  logger.info(`Report: ${reportPath}`);
  if (testFiles.length > 0) {
    logger.info(`Test Files Generated: ${testFiles.length}`);
    for (const f of testFiles) logger.info(`  - ${f}`);
  }
  logger.info(`${'═'.repeat(60)}\n`);

  return {
    success: true,
    config,
    journeyResults,
    issues: issueTracker.issues,
    screenshots: issueTracker.screenshots,
    reportPath,
    testFiles,
    duration: totalDuration
  };
}

module.exports = { runAgent, runComprehensiveQA, parseComprehensivePrompt, executeAgentStep, waitForPageStable, execCode };
