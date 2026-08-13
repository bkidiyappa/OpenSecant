/**
 * Headed recording session with in-page overlay UI.
 */
const path = require('path');
const fs = require('fs');
const logger = require('../../utils/logger');
const { launchBrowser, getDefaultContextOptions, newPage } = require('../../runner/browserLauncher');
const { getRecorderInjectSource } = require('./injectScript');
const { eventToNlStep, consolidateRecordedItems } = require('./nlExporter');
const { eventToPlaywrightCode } = require('./codeExporter');
const { generateTestFile } = require('../agent/testGenerator');
const { getStepStore } = require('../../store/stepStore');
const { paths: frameworkPaths } = require('../../config/frameworkConfig');
const { normalizeNavigationUrl } = require('../../utils/urlUtils');

/**
 * @param {string} startUrl
 * @param {{ testName?: string, outputDir?: string, tags?: string[] }} options
 * @returns {Promise<{ testFilePath: string, steps: Array, sessionPath: string }>}
 */
async function runRecordingSession(startUrl, options = {}) {
  const testName = options.testName || `recorded-${Date.now()}`;
  const outputDir = options.outputDir || path.join(frameworkPaths.tests, 'recorded');
  const tags = options.tags || ['@recorded', '@smoke'];

  let url = startUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = normalizeNavigationUrl(url);
  }

  const recorded = [];
  let stopResolve;
  const stopPromise = new Promise((resolve) => {
    stopResolve = resolve;
  });

  const browser = await launchBrowser({ headless: false });
  // Force headed for overlay interaction
  const context = await browser.newContext({
    ...getDefaultContextOptions(),
    viewport: null,
  });

  await context.exposeBinding('opensecantRecord', async ({ page: bindingPage }, payload) => {
    try {
      await handleBridgeMessage(payload, bindingPage);
    } catch (err) {
      logger.warning(`[Recorder] bridge error: ${err.message}`);
    }
  });

  await context.addInitScript(getRecorderInjectSource());

  const page = await newPage(context);

  async function syncOverlaySteps(bindingPage) {
    if (!bindingPage || bindingPage.isClosed()) return;
    const labels = recorded.map((r, i) => `${i + 1}. ${r.nlStep}`);
    try {
      await bindingPage.evaluate((labelsIn) => {
        const list = document.querySelector('#osr-list');
        if (!list) return;
        list.innerHTML = '';
        labelsIn.forEach((label) => {
          const li = document.createElement('li');
          li.textContent = label;
          list.appendChild(li);
        });
        list.scrollTop = list.scrollHeight;
        if (window.__opensecantRecorderInstalled) {
          /* keep Node as source of truth after navigations */
        }
      }, labels);
    } catch (_) { /* page mid-navigation */ }
  }

  async function handleBridgeMessage(payload, bindingPage) {
    if (!payload || typeof payload !== 'object') return;

    if (payload.kind === 'ready') {
      logger.info(`[Recorder] Overlay ready on ${payload.url}`);
      await syncOverlaySteps(bindingPage);
      return;
    }

    if (payload.kind === 'status') {
      logger.info(`[Recorder] Status: ${payload.status}`);
      return;
    }

    if (payload.kind === 'undo') {
      if (recorded.length > 0) {
        const removed = recorded.pop();
        logger.info(`[Recorder] Undo: ${removed.nlStep}`);
      }
      return;
    }

    if (payload.kind === 'step' && payload.step) {
      const event = payload.step;
      const nlStep = eventToNlStep(event);
      const code = eventToPlaywrightCode(event);
      // Skip duplicate navigate for the same URL as the seed step
      if (
        event.type === 'navigate' &&
        recorded.length > 0 &&
        recorded[recorded.length - 1].event?.type === 'navigate' &&
        recorded[recorded.length - 1].event.url === event.url
      ) {
        return;
      }
      recorded.push({ nlStep, code, event, success: true, step: nlStep });
      logger.info(`[Recorder] + ${nlStep}`);
      logger.info(`           → ${code}`);
      return;
    }

    if (payload.kind === 'stop') {
      logger.info('[Recorder] Stop requested from overlay — saving…');
      stopResolve('overlay');
    }
  }

  // Seed initial navigation as a step after load
  logger.info(`[Recorder] Opening ${url}`);
  logger.info('[Recorder] Use the floating overlay: Start → interact → Stop & Save');
  logger.info('[Recorder] Recording stays idle until you click Start (ignores site auto-clicks)');
  logger.info('[Recorder] Or press Ctrl+C in this terminal to save and exit');

  page.on('close', () => stopResolve('page-closed'));

  const onSigInt = () => {
    logger.info('[Recorder] Ctrl+C — saving session…');
    stopResolve('SIGINT');
  };
  process.once('SIGINT', onSigInt);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Explicit first navigate step (overlay may also detect URL)
    if (recorded.length === 0 || recorded[0].event?.type !== 'navigate') {
      const navEvent = { type: 'navigate', timestamp: Date.now(), url: page.url(), target: null };
      recorded.unshift({
        nlStep: eventToNlStep(navEvent),
        code: eventToPlaywrightCode(navEvent),
        event: navEvent,
        success: true,
        step: eventToNlStep(navEvent),
      });
      logger.info(`[Recorder] + ${recorded[0].nlStep}`);
    }

    await stopPromise;
  } finally {
    process.removeListener('SIGINT', onSigInt);
  }

  const consolidated = consolidateRecordedItems(recorded).map((r) => {
    const nlStep = eventToNlStep(r.event);
    const code = eventToPlaywrightCode(r.event);
    return {
      nlStep,
      code,
      event: r.event,
      success: true,
      step: nlStep,
    };
  });
  const forGenerator = consolidated.map((r) => ({
    step: r.nlStep,
    code: r.code,
    success: true,
    source: 'recorder',
  }));

  const testFilePath = generateTestFile(testName, forGenerator, {
    tags,
    outputDir,
    dedupeSteps: false,
  });

  // Persist to stepstore
  const stepStore = getStepStore();
  for (const item of forGenerator) {
    try {
      stepStore.set(item.step, item.code);
    } catch (_) { /* ignore */ }
  }

  // Session JSON for debugging / object info
  const sessionDir = path.join(frameworkPaths.root, 'reports', 'recorder');
  if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  const sessionPath = path.join(sessionDir, `${path.basename(testFilePath, '.test')}-session.json`);
  fs.writeFileSync(
    sessionPath,
    JSON.stringify(
      {
        testName,
        startUrl: url,
        savedAt: new Date().toISOString(),
        steps: consolidated.map((r) => ({
          nlStep: r.nlStep,
          code: r.code,
          event: r.event,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  logger.success(`[Recorder] Saved test: ${testFilePath}`);
  logger.info(`[Recorder] Session detail: ${sessionPath}`);
  logger.info(`[Recorder] ${forGenerator.length} step(s) written to stepstore`);

  try {
    await context.close();
  } catch (_) {}
  try {
    await browser.close();
  } catch (_) {}

  return { testFilePath, steps: forGenerator, sessionPath };
}

module.exports = {
  runRecordingSession,
};
