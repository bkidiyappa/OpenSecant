/**
 * Page Data Capture Module
 * Functions for capturing page elements, accessibility data, and HTML content
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

/**
 * Format accessibility node into a more LLM-friendly text format
 * @param {Object} node - Accessibility node
 * @param {number} depth - Current depth level for indentation
 * @returns {string} - Formatted node as text
 */
function formatNode(node, depth = 0) {
  if (!node || !node.role) return '';
  const indent = '  '.repeat(depth);
  const parts = [];

  parts.push(`${indent}- ${node.role}: "${(node.name || '').trim()}"`);

  const props = [];
  if ('level' in node) props.push(`level ${node.level}`);
  if ('checked' in node) props.push(node.checked ? 'checked' : 'unchecked');
  if ('required' in node) props.push(node.required ? 'required' : 'optional');

  if (props.length > 0) {
    parts[parts.length - 1] += ` (${props.join(', ')})`;
  }

  if (node.children && Array.isArray(node.children)) {
    for (const child of node.children) {
      parts.push(formatNode(child, depth + 1));
    }
  }

  return parts.join('\n');
}

/**
 * Capture a browser snapshot using Playwright's accessibility snapshot
 * @param {Object} page - Playwright page object
 * @returns {Promise<Object>} - Accessibility snapshot of the page
 */
async function captureBrowserSnapshot(page) {
  try {
    if (!page.accessibility) {
      logger.info('Browser accessibility API not available (Playwright 1.49+)');
      return null;
    }
    const snapshot = await page.accessibility.snapshot();
    const formattedSnapshot = formatNode(snapshot);
    
    return {
      accessibility: snapshot,
      formattedAccessibility: formattedSnapshot
    };
  } catch (error) {
    logger.error(`Error capturing browser snapshot: ${error.message}`);
    return null;
  }
}

/**
 * Extract interactive elements from the page
 * @param {Object} page - Playwright page object
 * @returns {Promise<Array>} - Array of interactive elements with their properties
 */
async function extractInteractiveElements(page) {
  try {
    const interactiveElements = await page.evaluate(() => {
      const clickableSelectors = `a, 
                                  button, 
                                  [role="button"],
                                  [role=link],
                                  [role=textbox],
                                  [role=checkbox],
                                  [role=combobox],
                                  [role=radio], 
                                  [onclick], 
                                  input[type='submit'], 
                                  input[type='button']`;
      const inputSelectors = `input:not([type='submit']):not([type='button']), 
                              textarea, 
                              [contenteditable='true'], 
                              select`;
      
      const uniqueClickableElements = Array.from(document.querySelectorAll(clickableSelectors));
      const uniqueInputElements = Array.from(document.querySelectorAll(inputSelectors));
      
      function getElementInfo(element) {
        const { top, left, bottom, right, width, height } = element.getBoundingClientRect();
        const attributes = {};
        
        for (let i = 0; i < element.attributes.length; i++) {
          const attr = element.attributes[i];
          attributes[attr.name] = attr.value;
        }
        
        return {
          type: element.type || element.tagName.toLowerCase(),
          tagName: element.tagName.toLowerCase(),
          text: element.textContent?.trim() || null,
          placeholder: element.placeholder || null,
          id: element.id || null,
          name: element.getAttribute('name') || null,
          ariaLabel: element.getAttribute('aria-label') || null,
          role: element.getAttribute('role') || null,
          coordinate: {
            x: Math.round(left + width / 2),
            y: Math.round(top + height / 2),
          },
          attributes,
          isVisibleInCurrentViewPort: 
            top >= 0 && left >= 0 && 
            bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            right <= (window.innerWidth || document.documentElement.clientWidth)
        };
      }
      
      return [
        ...uniqueClickableElements.map(getElementInfo),
        ...uniqueInputElements.map(getElementInfo)
      ];
    });
    
    return interactiveElements;
  } catch (error) {
    logger.error(`Error extracting interactive elements: ${error.message}`);
    return [];
  }
}

/**
 * Simplify HTML content to focus on important elements for locator analysis
 * @param {string} html - Full HTML content
 * @returns {string} - Simplified HTML focusing on key elements
 */
function simplifyHtml(html) {
  let simplified = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  
  if (simplified.length > 10000) {
    simplified = simplified.substring(0, 10000) + '...';
  }
  
  return simplified;
}

/**
 * Write data to a timestamped file
 * @param {*} data - Data to write (will be JSON stringified)
 * @param {string} prefix - Filename prefix
 * @param {string} extension - File extension (without dot)
 * @param {string} runDir - Optional run directory
 */
function writeToFileWithTimestamp(data, prefix, extension, runDir = null) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${prefix}-${timestamp}.${extension}`;
    
    const outputDir = runDir || path.join(__dirname, '../../output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const filepath = path.join(outputDir, filename);
    const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    
    fs.writeFileSync(filepath, content, 'utf8');
    logger.info(`Data written to: ${filepath}`);
  } catch (error) {
    logger.error(`Error writing to file: ${error.message}`);
  }
}

/**
 * Captures hybrid input data from the page including tag, attributes, and accessibility info
 * @param {Object} page - Playwright page object
 * @param {string} runDir - Optional run directory to store the file in
 * @param {string} stepDescription - Optional step description for modal wait logic
 * @returns {Promise<Array>} - Array of hybrid data objects
 */
async function captureHybridInputData(page, runDir = null, stepDescription = null) {
  try {
    // For dismiss/close actions, wait a bit for modals to appear
    if (stepDescription && /^(close|dismiss|hide)\s/i.test(stepDescription)) {
      logger.info(`[MODAL WAIT] Detected dismiss action, waiting for modal elements...`);
      try {
        await page.waitForSelector('button[data-modal-hide], button[data-dismiss], button[data-bs-dismiss], .close-modal-btn, .modal-close, [role="dialog"]', { 
          timeout: 20000,
          state: 'attached'
        });
        logger.info(`[MODAL WAIT] Modal element found, waiting 500ms for animation`);
        await page.waitForTimeout(500);
        
        const buttonCount = await page.locator('button[data-modal-hide], .close-modal-btn').count();
        logger.info(`[MODAL WAIT] Found ${buttonCount} modal close button(s) in DOM`);
      } catch (e) {
        logger.info(`[MODAL WAIT] No modal found within 20s timeout: ${e.message}`);
      }
    }
    
    const selector = [
      'input', 'textarea', 'select', 'button', 'a',
      '[role]', '[data-testid]', '[data-test]', '[testdataid]', 
      'label', 'form', '.btn', '.button', '[tabindex="0"]',
      '[aria-label]', '[aria-labelledby]', '[aria-describedby]'
    ].join(',');

    // ── Pre-capture DOM settlement check ──────────────────────────────────
    // Detect if content is still loading (SPA transitions) by checking
    // if interactive element count is still changing.
    try {
      let prev = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
      await page.waitForTimeout(300);
      let curr = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
      if (curr !== prev) {
        logger.info(`[DATA CAPTURE] DOM still changing (${prev} → ${curr}), waiting for settlement...`);
        const maxWait = Date.now() + 5000;
        while (Date.now() < maxWait) {
          await page.waitForTimeout(500);
          prev = curr;
          curr = await page.evaluate((sel) => document.querySelectorAll(sel).length, selector);
          if (curr === prev && curr > 0) break;
        }
        logger.info(`[DATA CAPTURE] DOM settled at ${curr} elements`);
      }
    } catch (_) { /* page may have closed, proceed with capture anyway */ }

    // ── BATCHED capture: single page.evaluate() for all DOM data ──────────
    const batchResult = await page.evaluate((sel) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const results = [];
      let invisibleSkipped = 0;
      let modalButtonsCaptured = 0;

      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0 &&
          window.getComputedStyle(node).visibility !== 'hidden' &&
          window.getComputedStyle(node).display !== 'none';

        const hasModalAttr = node.hasAttribute('data-modal-hide') ||
          node.hasAttribute('data-dismiss') ||
          node.hasAttribute('data-bs-dismiss');

        if (hasModalAttr) modalButtonsCaptured++;

        if (!isVisible && !hasModalAttr) { invisibleSkipped++; continue; }

        // Disabled check
        const isDisabled = node.disabled === true ||
          node.getAttribute('aria-disabled') === 'true' ||
          node.classList.contains('Mui-disabled') ||
          node.classList.contains('disabled') ||
          node.classList.contains('disable-btn');
        if (isDisabled && !hasModalAttr) { invisibleSkipped++; continue; }

        // Container wrapping disabled children
        if (!isDisabled && !hasModalAttr) {
          const children = node.querySelectorAll('button, input, select, textarea, a[href]');
          if (children.length > 0 && [...children].every(c =>
            c.disabled || c.getAttribute('aria-disabled') === 'true' || c.classList.contains('Mui-disabled')
          )) { invisibleSkipped++; continue; }
        }

        const grab = attr => node.hasAttribute(attr) ? node.getAttribute(attr) : undefined;

        // Label resolution
        const id = node.id;
        let labelText = undefined;
        if (id) {
          try {
            const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lbl) labelText = lbl.innerText.trim();
          } catch (_) {}
        }
        if (!labelText) {
          const parentLabel = node.closest('label');
          if (parentLabel) labelText = parentLabel.innerText.trim();
        }

        // Ancestor testid walk (up to 5 levels)
        let ancestorTestId = undefined;
        let ancestorTestDataId = undefined;
        let ancestor = node.parentElement;
        for (let i = 0; i < 5 && ancestor; i++) {
          if (!ancestorTestId && ancestor.hasAttribute('data-testid')) {
            ancestorTestId = ancestor.getAttribute('data-testid');
          }
          if (!ancestorTestDataId && ancestor.hasAttribute('testdataid')) {
            ancestorTestDataId = ancestor.getAttribute('testdataid');
          }
          if (ancestorTestId && ancestorTestDataId) break;
          ancestor = ancestor.parentElement;
        }

        // Collect all data-* attributes
        const allDataAttrs = {};
        for (const attr of node.attributes) {
          if (attr.name.startsWith('data-')) allDataAttrs[attr.name] = attr.value;
        }

        // Parent snippet
        const p = node.parentElement;
        const parent = p ? {
          tag: p.tagName.toLowerCase(),
          id: p.getAttribute('id') || undefined,
          role: p.getAttribute('role') || undefined,
          'testdataid': p.getAttribute('testdataid') || undefined,
          'data-testid': p.getAttribute('data-testid') || undefined,
          'aria-label': p.getAttribute('aria-label') || undefined
        } : undefined;

        const innerText = node instanceof HTMLElement ? node.innerText.trim() : '';

        results.push({
          tag: node.tagName.toLowerCase(),
          type: grab('type') ?? undefined,
          attributes: {
            id: grab('id'),
            name: grab('name'),
            placeholder: grab('placeholder'),
            'data-testid': grab('data-testid') || ancestorTestId,
            'data-test': grab('data-test'),
            'testdataid': grab('testdataid') || ancestorTestDataId,
            'aria-label': grab('aria-label'),
            'aria-labelledby': grab('aria-labelledby'),
            'aria-describedby': grab('aria-describedby'),
            ...allDataAttrs
          },
          value: node.value ?? undefined,
          labelText,
          text: innerText || undefined,
          parent,
          hasModalAttr,
          position: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          }
        });
      }
      return { results, invisibleSkipped, modalButtonsCaptured };
    }, selector);

    logger.info(`HYBRID DATA CAPTURE: Found ${batchResult.results.length + batchResult.invisibleSkipped} raw elements on page (URL: ${page.url()})`);

    // ── Per-element accessibility snapshot (still requires handle, but only for captured elements) ──
    const hybridData = [];
    let axErrors = 0;
    const hasAccessibility = !!page.accessibility;

    if (hasAccessibility && batchResult.results.length <= 200) {
      // Only do per-element ax snapshots when element count is manageable
      const handles = await page.$$(selector);
      const handleMap = new Map();
      // Build a lightweight index to match batch results back to handles
      let hIdx = 0;
      let rIdx = 0;
      let invisCount = 0;

      for (const el of batchResult.results) {
        // Skip forward in handles to account for invisible/disabled elements that were skipped
        // We need to find the right handle — use a simple try approach
        let ax = null;
        try {
          // Try to get ax snapshot for this element by walking handles
          while (hIdx < handles.length) {
            const h = handles[hIdx];
            hIdx++;
            try {
              const isMatch = await h.evaluate((node, expected) => {
                const tag = node.tagName.toLowerCase();
                const id = node.getAttribute('id') || undefined;
                const name = node.getAttribute('name') || undefined;
                return tag === expected.tag && id === expected.id && name === expected.name;
              }, { tag: el.tag, id: el.attributes?.id, name: el.attributes?.name });
              if (isMatch) {
                try {
                  ax = await page.accessibility.snapshot({ root: h });
                } catch (_) {}
                break;
              }
            } catch (_) { continue; }
          }
        } catch (_) { axErrors++; }

        const { hasModalAttr, ...cleanEl } = el;
        cleanEl.accessibility = ax ? {
          role: ax.role,
          name: ax.name || null,
          checked: ax.checked,
          required: ax.required,
          focused: ax.focused,
          disabled: ax.disabled,
          level: ax.level
        } : undefined;
        hybridData.push(cleanEl);
      }
    } else {
      // Skip accessibility snapshots entirely (too many elements or API unavailable)
      for (const el of batchResult.results) {
        const { hasModalAttr, ...cleanEl } = el;
        hybridData.push(cleanEl);
      }
    }

    logger.info(`HYBRID DATA CAPTURE: Complete — ${hybridData.length} captured, ${batchResult.invisibleSkipped} invisible/disabled skipped, ${axErrors} ax errors, ${batchResult.modalButtonsCaptured} modal buttons`);
    return hybridData;
  } catch (error) {
    logger.error(`Error capturing hybrid input data: ${error.message}`);
    return [];
  }
}

module.exports = {
  formatNode,
  captureBrowserSnapshot,
  extractInteractiveElements,
  simplifyHtml,
  writeToFileWithTimestamp,
  captureHybridInputData
};
