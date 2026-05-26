/**
 * Site Explorer — crawls a website to discover pages, forms, links, and CTAs.
 *
 * Given a starting URL, the explorer:
 *   1. Navigates to the home page
 *   2. Discovers all internal links and navigation elements
 *   3. Visits each discovered page (breadth-first, depth-limited)
 *   4. Captures forms, buttons, CTAs on each page
 *   5. Identifies testable flows (form submissions, multi-step wizards, bookings)
 *   6. Produces a flow manifest for the flow runner
 *
 * Usage (internal):
 *   const { exploreSite } = require('./siteExplorer');
 *   const manifest = await exploreSite('https://example.com', { maxPages: 20 });
 */

const logger = require('../../utils/logger');
const { launchBrowser, getDefaultContextOptions } = require('../../runner/browserLauncher');
const { discoverFlowsWithLLM } = require('./flowDiscovery');

const MAX_PAGES = 20;
const PAGE_TIMEOUT = 25000;
const CTA_LINK_RE = /contact|demo|request|schedule|book|quote|sign|login|support|solution|product|pricing|trial|get started|learn more|about/i;

function verboseExplorer() {
  return process.env.OPENSECANT_VERBOSE === 'true';
}

/**
 * Extract the origin (scheme + host) from a URL.
 */
function getOrigin(url) {
  try {
    const u = new URL(url);
    return u.origin;
  } catch (_) {
    return null;
  }
}

/** Hostname without www — treats lytx.com and www.lytx.com as same site. */
function getSiteKey(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) {
    return null;
  }
}

function isSameSite(url, siteKey) {
  if (!url || !siteKey) return false;
  return getSiteKey(url) === siteKey;
}

/**
 * Normalize a URL by removing trailing slashes, hash, and query params for dedup.
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    // Keep path, remove hash and query
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return u.origin + path;
  } catch (_) {
    return url;
  }
}

/**
 * Check if a URL is worth visiting (internal, not a file download, etc.)
 */
function isNavigableUrl(url, siteKey) {
  if (!isSameSite(url, siteKey)) return false;
  if (/\.(pdf|jpg|jpeg|png|gif|svg|css|js|ico|woff|woff2|ttf|eot|mp4|mp3|zip|doc|xlsx?)$/i.test(url)) return false;
  if (/^(mailto:|tel:|javascript:|#)/i.test(url)) return false;
  return true;
}

function linkPriority(link) {
  if (CTA_LINK_RE.test(link.text || '')) return 0;
  if (link.text && link.text.length < 40) return 1;
  return 2;
}

/**
 * Capture page information: forms, links, buttons, CTAs, and page metadata.
 */
async function capturePageInfo(page) {
  return await page.evaluate(() => {
    const origin = window.location.origin;

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    // Collect internal links
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      if (!isVisible(a)) continue;
      const href = a.href;
      const text = (a.textContent || '').trim().substring(0, 100);
      if (href && href.startsWith(origin) && text) {
        links.push({ href, text });
      }
    }

    // Collect forms
    const forms = [];
    for (const form of document.querySelectorAll('form')) {
      const fields = [];
      for (const input of form.querySelectorAll('input, textarea, select')) {
        if (!isVisible(input)) continue;
        const label = input.getAttribute('aria-label')
          || input.getAttribute('placeholder')
          || input.getAttribute('name')
          || input.id
          || '';
        fields.push({
          tag: input.tagName.toLowerCase(),
          type: input.type || 'text',
          name: input.getAttribute('name') || '',
          label: label.substring(0, 80),
          required: input.required || input.getAttribute('aria-required') === 'true'
        });
      }
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      forms.push({
        action: form.action || '',
        method: form.method || 'GET',
        fields,
        submitText: submitBtn ? (submitBtn.textContent || '').trim().substring(0, 60) : '',
        fieldCount: fields.length
      });
    }

    // Collect standalone form fields (not inside a <form> tag)
    const standaloneFields = [];
    for (const input of document.querySelectorAll('input, textarea, select')) {
      if (input.closest('form')) continue;
      if (!isVisible(input)) continue;
      const label = input.getAttribute('aria-label')
        || input.getAttribute('placeholder')
        || input.getAttribute('name')
        || input.id
        || '';
      if (label) {
        standaloneFields.push({
          tag: input.tagName.toLowerCase(),
          type: input.type || 'text',
          name: input.getAttribute('name') || '',
          label: label.substring(0, 80),
          required: input.required || input.getAttribute('aria-required') === 'true'
        });
      }
    }

    // Collect buttons / CTAs
    const buttons = [];
    for (const btn of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || btn.value || '').trim().substring(0, 80);
      if (text && text.length > 1) {
        buttons.push({
          text,
          type: btn.type || 'button',
          tag: btn.tagName.toLowerCase()
        });
      }
    }

    // Collect navigation items
    const navLinks = [];
    for (const nav of document.querySelectorAll('nav, [role="navigation"], header')) {
      for (const a of nav.querySelectorAll('a[href]')) {
        if (!isVisible(a)) continue;
        const text = (a.textContent || '').trim().substring(0, 80);
        if (text && a.href.startsWith(origin)) {
          navLinks.push({ href: a.href, text });
        }
      }
    }

    // Page title and headings
    const title = document.title || '';
    const h1 = document.querySelector('h1');
    const heading = h1 ? (h1.textContent || '').trim().substring(0, 120) : '';

    // Detect multi-step indicators
    const hasProgressBar = !!document.querySelector('[class*="progress"], [class*="stepper"], [class*="wizard"], [role="progressbar"]');
    const hasStepIndicator = !!document.querySelector('[class*="step-indicator"], [class*="step-number"], [class*="breadcrumb"]');

    return {
      title,
      heading,
      links: links.slice(0, 50),
      navLinks: navLinks.slice(0, 30),
      forms,
      standaloneFields: standaloneFields.slice(0, 20),
      buttons: buttons.slice(0, 30),
      hasProgressBar,
      hasStepIndicator,
      url: window.location.href
    };
  });
}

/**
 * Classify a page based on its content.
 * Returns: 'form', 'landing', 'listing', 'confirmation', 'content', 'unknown'
 */
function classifyPage(pageInfo) {
  const totalFields = (pageInfo.forms.reduce((sum, f) => sum + f.fieldCount, 0))
    + pageInfo.standaloneFields.length;

  if (totalFields >= 3) return 'form';
  if (pageInfo.hasProgressBar || pageInfo.hasStepIndicator) return 'wizard';
  if (/confirm|thank|success|complete|receipt/i.test(pageInfo.heading + ' ' + pageInfo.title)) return 'confirmation';
  if (pageInfo.links.length > 15) return 'listing';
  if (totalFields >= 1) return 'form-light';
  return 'content';
}

/**
 * Use the LLM to identify testable flows from the site map.
 * Falls back to heuristic-based flow detection if LLM is unavailable.
 */
function identifyFlows(siteMap, startUrl) {
  const flows = [];
  const origin = getOrigin(startUrl);

  // Strategy 1: Pages with forms are testable flows
  for (const [url, info] of Object.entries(siteMap)) {
    if (info.type === 'form' || info.type === 'wizard' || info.type === 'form-light') {
      const formInfo = info.forms[0] || {};
      const fields = formInfo.fields || info.standaloneFields || [];
      const submitText = formInfo.submitText || '';

      // Build a flow name from page heading or title
      const name = info.heading || info.title || url.replace(origin, '').replace(/\//g, ' ').trim() || 'Form';

      // Build entry path: how to get to this page from the home page
      const entryPath = info.entryPath || [];

      flows.push({
        name: sanitizeFlowName(name),
        type: info.type === 'wizard' ? 'multi-step-form' : 'form',
        url,
        entryPath,
        goal: `On ${startUrl} complete the ${name} form and submit`,
        fields: fields.map(f => ({
          name: f.name || f.label,
          type: f.type,
          required: f.required,
          label: f.label
        })),
        submitText,
        fieldCount: fields.length,
        priority: fields.length >= 5 ? 'high' : fields.length >= 2 ? 'medium' : 'low',
        source: 'heuristic',
      });
    }
  }

  // Strategy 2: CTA / nav journeys (even if target page not fully classified as form)
  const seenUrls = new Set(flows.map((f) => normalizeUrl(f.url)));
  for (const [fromUrl, info] of Object.entries(siteMap)) {
    for (const link of [...(info.navLinks || []), ...(info.links || [])]) {
      if (!CTA_LINK_RE.test(link.text || '')) continue;
      const targetNorm = normalizeUrl(link.href);
      if (seenUrls.has(targetNorm)) {
        const existing = flows.find((f) => normalizeUrl(f.url) === targetNorm);
        if (existing && existing.entryPath.length === 0) {
          existing.entryPath = [{ action: `click on ${link.text} link`, fromUrl }];
        }
        continue;
      }
      seenUrls.add(targetNorm);
      flows.push({
        name: sanitizeFlowName(link.text),
        type: 'navigation',
        url: link.href,
        entryPath: [{ action: `click on ${link.text} link`, fromUrl }],
        goal: `On ${startUrl} open ${link.text} and verify the page loads with expected content`,
        fieldCount: 0,
        priority: 'medium',
        source: 'heuristic',
      });
    }
  }

  // Strategy 3: Home page with a search/zip field (e.g. "Find your local X")
  const homeInfo = siteMap[normalizeUrl(startUrl)] || siteMap[startUrl];
  if (homeInfo && homeInfo.standaloneFields.length > 0) {
    const zipField = homeInfo.standaloneFields.find(f =>
      /zip|postal|location|search/i.test(f.label + ' ' + f.name)
    );
    if (zipField) {
      const ctaBtn = homeInfo.buttons.find(b =>
        /find|search|go|locate|get started/i.test(b.text)
      );
      if (ctaBtn) {
        // Check if this leads to a form flow — add as the first step
        for (const flow of flows) {
          if (flow.entryPath.length === 0 || flow.entryPath[0].fromUrl === startUrl) {
            flow.entryPath.unshift(
              { action: `fill ${zipField.label} as 10001`, fromUrl: startUrl },
              { action: `click on ${ctaBtn.text} button`, fromUrl: startUrl }
            );
            break;
          }
        }
      }
    }
  }

  // Sort by priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  flows.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

  return flows.slice(0, 15);
}

/**
 * Merge heuristic + LLM flows; ensure at least one agent exploration flow.
 */
async function resolveFlows(siteMap, startUrl, useLlm) {
  let flows = identifyFlows(siteMap, startUrl);
  logger.info(`[Explorer] Heuristic flows: ${flows.length}`);

  if (useLlm && Object.keys(siteMap).length > 0) {
    const llmFlows = await discoverFlowsWithLLM(siteMap, startUrl);
    const seen = new Set(flows.map((f) => normalizeUrl(f.url)));
    for (const f of llmFlows) {
      const key = normalizeUrl(f.url);
      if (!seen.has(key)) {
        seen.add(key);
        flows.push(f);
      }
    }
    logger.info(`[Explorer] After LLM merge: ${flows.length} flow(s)`);
  }

  if (flows.length === 0) {
    flows = [{
      name: 'site-exploration',
      type: 'agent-explore',
      url: startUrl,
      entryPath: [],
      goal: `Explore ${startUrl}: visit main navigation, product/solution pages, and contact or demo flows. Build a smoke test from successful steps.`,
      priority: 'high',
      fieldCount: 0,
      source: 'fallback',
    }];
    logger.info('[Explorer] Using fallback agent-explore flow');
  }

  return flows.slice(0, 15);
}

/**
 * Sanitize a flow name for use as a test file name.
 */
function sanitizeFlowName(name) {
  return name
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .substring(0, 60);
}

/**
 * Explore a website: crawl pages, capture info, identify flows.
 *
 * @param {string} startUrl - The URL to start exploring
 * @param {Object} options - { maxPages, headless }
 * @returns {Promise<Object>} Flow manifest
 */
async function exploreSite(startUrl, options = {}) {
  const maxPages = options.maxPages || MAX_PAGES;
  const useLlm = options.useLlm !== false;
  let siteKey = getSiteKey(startUrl);

  if (!siteKey) {
    logger.error('[Explorer] Invalid start URL');
    return { site: startUrl, flows: [], siteMap: {}, error: 'Invalid URL' };
  }

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`SITE EXPLORER STARTED`);
  logger.info(`URL: ${startUrl}`);
  logger.info(`Max pages: ${maxPages}`);
  logger.info(`${'═'.repeat(60)}\n`);

  const browser = await launchBrowser();
  const context = await browser.newContext(getDefaultContextOptions());
  const page = await context.newPage();

  const visited = new Set();
  const toVisit = [{ url: normalizeUrl(startUrl), entryPath: [] }];
  const siteMap = {};

  try {
    while (toVisit.length > 0 && visited.size < maxPages) {
      const { url: currentUrl, entryPath } = toVisit.shift();
      const normalized = normalizeUrl(currentUrl);

      if (visited.has(normalized)) continue;
      visited.add(normalized);

      logger.info(`[Explorer] Visiting (${visited.size}/${maxPages}): ${currentUrl}`);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        // Wait for dynamic content
        try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
        await page.waitForTimeout(1000);

        const pageInfo = await capturePageInfo(page);
        const pageType = classifyPage(pageInfo);

        logger.info(`[Explorer]   Type: ${pageType} | Forms: ${pageInfo.forms.length} | Links: ${pageInfo.links.length} | Fields: ${pageInfo.standaloneFields.length}`);

        siteMap[normalized] = {
          ...pageInfo,
          type: pageType,
          entryPath
        };

        // Discover new URLs to visit
        // After first load, align site key with redirect target (e.g. lytx.com → www.lytx.com)
        const liveKey = getSiteKey(page.url());
        if (liveKey) siteKey = liveKey;

        const allLinks = [...(pageInfo.navLinks || []), ...(pageInfo.links || [])];
        const sortedLinks = allLinks
          .filter((link) => isNavigableUrl(link.href, siteKey))
          .sort((a, b) => linkPriority(a) - linkPriority(b));

        for (const link of sortedLinks) {
          const linkNorm = normalizeUrl(link.href);
          if (!visited.has(linkNorm)) {
            const alreadyQueued = toVisit.some((t) => normalizeUrl(t.url) === linkNorm);
            if (!alreadyQueued) {
              toVisit.push({
                url: link.href,
                entryPath: [...entryPath, { action: `click on ${link.text} link`, fromUrl: currentUrl }],
              });
            }
          }
        }

        if (verboseExplorer()) {
          logger.info(`[Explorer]   Queued ${toVisit.length} URLs (site: ${siteKey})`);
        }

      } catch (err) {
        logger.warning(`[Explorer] Failed to visit ${currentUrl}: ${err.message}`);
      }
    }

    // Take a final screenshot
    try {
      const screenshotPath = require('path').join(__dirname, '../../../reports', 'explorer_final.png');
      await page.screenshot({ path: screenshotPath, fullPage: false });
    } catch (_) {}

  } finally {
    await context.close();
    await browser.close();
  }

  const flows = await resolveFlows(siteMap, startUrl, useLlm);
  const origin = getOrigin(startUrl) || `https://${siteKey}`;

  logger.info(`\n${'═'.repeat(60)}`);
  logger.info(`SITE EXPLORER FINISHED`);
  logger.info(`Pages visited: ${visited.size}`);
  logger.info(`Flows discovered: ${flows.length}`);
  for (const f of flows) {
    logger.info(`  - [${f.priority}] ${f.name} (${f.type}) → ${f.url}`);
  }
  logger.info(`${'═'.repeat(60)}\n`);

  const manifest = {
    site: startUrl,
    origin,
    exploredAt: new Date().toISOString(),
    pagesVisited: visited.size,
    siteMap: Object.fromEntries(
      Object.entries(siteMap).map(([url, info]) => [url, {
        title: info.title,
        heading: info.heading,
        type: info.type,
        formCount: info.forms.length,
        fieldCount: info.forms.reduce((s, f) => s + f.fieldCount, 0) + info.standaloneFields.length,
        linkCount: info.links.length,
        entryPath: info.entryPath
      }])
    ),
    flows
  };

  return manifest;
}

module.exports = { exploreSite, capturePageInfo, classifyPage };
