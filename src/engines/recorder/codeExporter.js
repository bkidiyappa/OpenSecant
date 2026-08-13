/**
 * Build Playwright code from a captured recorder event + target snapshot.
 */
const {
  normalizeElement,
  buildLocatorStrategies,
  extractWords,
  esc,
} = require('../locator/localEngine');
const { pickName, pickFieldName } = require('./nlExporter');

function targetToHybridElement(target) {
  if (!target) return null;
  return {
    tag: target.tag,
    type: target.type,
    text: target.text,
    labelText: target.labelText,
    value: target.value,
    attributes: target.attributes || {},
    position: target.position,
  };
}

function bestLocatorCode(target, intent = 'click') {
  const el = targetToHybridElement(target);
  if (!el) return null;

  const profile = normalizeElement(el);
  const nameHint = pickName(target) || pickFieldName(target);
  const words = extractWords(nameHint);
  const locs = buildLocatorStrategies(profile, words, nameHint);

  // Prefer href for anchors
  const href = el.attributes?.href;
  if (href && href !== '#' && !/^javascript:/i.test(href) && intent === 'click') {
    return `page.locator('a[href="${esc(href)}"]')`;
  }

  if (locs.length > 0) {
    return locs[0].code;
  }

  // Fallbacks
  const aria = el.attributes?.['aria-label'];
  if (aria) {
    const role = el.attributes?.role || (el.tag === 'a' ? 'link' : 'button');
    return `page.getByRole('${role}', { name: ${JSON.stringify(aria)}, exact: false })`;
  }

  if (nameHint) {
    return `page.getByText(${JSON.stringify(nameHint)}, { exact: false })`;
  }

  return null;
}

/**
 * @param {object} event
 * @returns {string} Playwright snippet with await
 */
function eventToPlaywrightCode(event) {
  if (!event) return '';

  if (event.type === 'navigate') {
    const url = event.url || '';
    return `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded' });`;
  }

  if (event.type === 'press') {
    const key = event.key || 'Enter';
    const pressLoc = event.target ? bestLocatorCode(event.target, 'fill') : null;
    if (pressLoc) {
      return `await ${pressLoc}.first().press(${JSON.stringify(key)});`;
    }
    return `await page.keyboard.press(${JSON.stringify(key)});`;
  }

  const loc = bestLocatorCode(event.target, event.type === 'fill' ? 'fill' : 'click');
  if (!loc) {
    return `await page.getByText(${JSON.stringify(pickName(event.target) || 'element')}, { exact: false }).first().click();`;
  }

  if (event.type === 'fill') {
    return `await ${loc}.first().fill(${JSON.stringify(String(event.value ?? ''))});`;
  }

  if (event.type === 'select') {
    return `await ${loc}.first().selectOption({ label: ${JSON.stringify(String(event.value ?? ''))} });`;
  }

  if (event.type === 'check') {
    return `await ${loc}.first().check();`;
  }

  if (event.type === 'uncheck') {
    return `await ${loc}.first().uncheck();`;
  }

  // click — force for aria-hidden overlays (shopping cards)
  const ariaHidden = event.target?.attributes?.['aria-hidden'] === 'true';
  if (ariaHidden) {
    return `await ${loc}.first().click({ force: true });`;
  }
  return `await ${loc}.first().click();`;
}

module.exports = {
  eventToPlaywrightCode,
  bestLocatorCode,
  targetToHybridElement,
};
