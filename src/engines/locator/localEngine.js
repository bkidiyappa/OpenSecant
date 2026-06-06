/**
 * Locator Engine — industry-standard local locator resolution.
 *
 * Ranks DOM + accessibility signals using Playwright's recommended priority:
 *   role+name → label → placeholder → text → test id → name → id (last resort)
 *
 * Used by actionLibrary.js before LLM fallback.
 */

const logger = require('../../utils/logger');

// ── Tokenization ───────────────────────────────────────────────────────────

const NOISE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'from', 'with', 'without', 'into', 'onto',
  'to', 'in', 'on', 'at', 'button', 'link', 'tab', 'field', 'input', 'option',
  'value', 'text', 'item', 'box', 'icon', 'btn',
]);

const TOKEN_CANONICAL_MAP = {
  signin: 'login',
  signon: 'login',
  logon: 'login',
  zipcode: 'zip',
  postcode: 'zip',
  postal: 'zip',
  telephone: 'phone',
  mobile: 'phone',
  tel: 'phone',
  pwd: 'password',
  pass: 'password',
  usr: 'user',
  username: 'user',
  emailaddress: 'email',
};

/** Playwright locator strategy base priority (higher = preferred). */
const STRATEGY_PRIORITY = {
  role_name: 100,
  test_id: 92,
  label: 88,
  placeholder: 84,
  alt_text: 80,
  title: 76,
  text: 72,
  name_attr: 58,
  id: 52,
  css_attr: 45,
};

const IMPLICIT_ROLES = {
  a: 'link',
  button: 'button',
  textarea: 'textbox',
  select: 'combobox',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  nav: 'navigation',
  main: 'main',
  form: 'form',
};

const INPUT_TYPE_ROLES = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  email: 'textbox',
  search: 'searchbox',
  tel: 'textbox',
  text: 'textbox',
  password: 'textbox',
  url: 'textbox',
  number: 'spinbutton',
};

function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeStep(step) {
  return String(step || '').replace(/\s*#\d+\s*$/, '').trim();
}

function extractWords(str) {
  const normalized = String(str || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[._:/\\-]+/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .toLowerCase();

  const words = normalized
    .split(/\s+/)
    .map((w) => TOKEN_CANONICAL_MAP[w] || w)
    .filter((w) => w.length >= 2 && !NOISE_WORDS.has(w));

  return [...new Set(words)];
}

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function wordOverlap(targetWords, candidateWords) {
  if (targetWords.length === 0) return 0;
  let matched = 0;
  for (const tw of targetWords) {
    let best = 0;
    for (const cw of candidateWords) {
      if (cw === tw) {
        best = 1;
        break;
      }
      if (cw.includes(tw) || tw.includes(cw)) {
        best = Math.max(best, 0.72);
      }
      const maxDist = Math.max(tw.length, cw.length) >= 5 ? 2 : 1;
      if (editDistance(tw, cw) <= maxDist) {
        best = Math.max(best, 0.86);
      }
    }
    matched += best;
  }
  return matched / targetWords.length;
}

function biOverlap(targetWords, candidateWords) {
  if (targetWords.length === 0 || candidateWords.length === 0) return 0;
  const fwd = wordOverlap(targetWords, candidateWords);
  const rev = wordOverlap(candidateWords, targetWords);
  return (fwd + rev) / 2;
}

function fieldAbbreviations(fieldName) {
  const words = fieldName.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return [];
  const abbrevs = [words.join('')];
  abbrevs.push(words[0][0] + words.slice(1).join(''));
  if (words[0].length >= 4) abbrevs.push(words[0]);
  return abbrevs;
}

function abbreviationMatch(fieldName, attrValue) {
  if (!attrValue) return false;
  const attrLower = attrValue.toLowerCase().replace(/[-_\s]/g, '');
  return fieldAbbreviations(fieldName).some(
    (abbr) => attrLower === abbr || attrLower.includes(abbr) || abbr.includes(attrLower),
  );
}

// ── Element profiling ────────────────────────────────────────────────────────

function getTestId(el) {
  const attrs = el.attributes || {};
  return attrs['data-testid'] || attrs['data-test'] || attrs.testdataid || attrs['data-qa'] || null;
}

function getImplicitRole(el) {
  const axRole = el.accessibility?.role;
  if (axRole) return axRole;

  const explicitRole = el.attributes?.role;
  if (explicitRole) return explicitRole;

  if (el.tag === 'input') {
    return INPUT_TYPE_ROLES[el.type] || 'textbox';
  }
  if (el.tag === 'div' && el.attributes?.contenteditable === 'true') {
    return 'textbox';
  }
  return IMPLICIT_ROLES[el.tag] || null;
}

function getAccessibleName(el) {
  const parts = [
    el.accessibility?.name,
    el.labelText,
    el.label,
    el.attributes?.['aria-label'],
    el.text,
    el.attributes?.title,
    el.attributes?.alt,
    el.attributes?.placeholder,
  ];
  for (const p of parts) {
    const trimmed = String(p || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function isDisabled(el) {
  return (
    el.accessibility?.disabled === true
    || el.attributes?.['aria-disabled'] === 'true'
    || el.attributes?.disabled === true
    || el.attributes?.disabled === ''
  );
}

function isVisibleEnough(el) {
  const pos = el.position;
  if (!pos) return true;
  return (pos.width || 0) > 0 && (pos.height || 0) > 0;
}

function elementSearchText(el) {
  const attrs = el.attributes || {};
  return [
    getAccessibleName(el),
    attrs.name,
    attrs.id,
    attrs.placeholder,
    getTestId(el),
    attrs.title,
    attrs.alt,
    attrs['aria-labelledby'],
    attrs['aria-describedby'],
    el.parent?.id,
    el.parent?.['aria-label'],
    el.parent?.['data-testid'],
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function normalizeElement(el) {
  const role = getImplicitRole(el);
  const name = getAccessibleName(el);
  const testId = getTestId(el);
  const attrs = el.attributes || {};

  return {
    el,
    role,
    name,
    nameWords: extractWords(name),
    searchText: elementSearchText(el),
    searchWords: extractWords(elementSearchText(el)),
    testId,
    testIdWords: extractWords(testId || ''),
    tag: el.tag,
    type: el.type || attrs.type,
    disabled: isDisabled(el),
    visible: isVisibleEnough(el),
    attrs,
  };
}

// ── Intent filters ───────────────────────────────────────────────────────────

function isInputField(el) {
  const profile = normalizeElement(el);
  const role = profile.role;
  return (
    el.tag === 'input'
    || el.tag === 'textarea'
    || el.tag === 'select'
    || role === 'textbox'
    || role === 'searchbox'
    || role === 'combobox'
    || role === 'spinbutton'
    || (el.tag === 'div' && el.attributes?.contenteditable === 'true')
  );
}

function isClickable(el) {
  const profile = normalizeElement(el);
  const role = profile.role;
  const clickableRoles = new Set([
    'button', 'link', 'tab', 'menuitem', 'option', 'radio', 'checkbox',
    'switch', 'treeitem', 'gridcell',
  ]);
  const clickableTypes = new Set(['button', 'submit', 'reset', 'checkbox', 'radio']);
  return (
    ['button', 'a'].includes(el.tag)
    || clickableRoles.has(role)
    || clickableTypes.has(profile.type)
    || el.attributes?.onclick
    || el.attributes?.tabindex === '0'
  );
}

function isSelectField(el) {
  const role = getImplicitRole(el);
  return el.tag === 'select' || role === 'combobox' || role === 'listbox';
}

function isCheckbox(el) {
  const role = getImplicitRole(el);
  return el.type === 'checkbox' || role === 'checkbox'
    || (el.tag === 'input' && el.type === 'checkbox');
}

function filterByIntent(elements, intent) {
  const list = elements || [];
  switch (intent) {
    case 'fill':
      return list.filter(isInputField);
    case 'click':
    case 'dismiss':
      return list.filter(isClickable);
    case 'select':
      return list;
    case 'check':
      return list.filter((el) => isCheckbox(el) || isClickable(el));
    case 'assert':
      return list;
    default:
      return list;
  }
}

// ── Locator builders (Playwright-first) ──────────────────────────────────────

function buildRoleNameLocator(profile, options = {}) {
  const { role, name } = profile;
  if (!role || !name) return null;
  const exact = options.exact === true;
  return {
    strategy: 'role_name',
    priority: STRATEGY_PRIORITY.role_name,
    score: 0,
    code: `page.getByRole('${role}', { name: '${esc(name)}', exact: ${exact} })`,
    description: `role=${role} name="${name}"`,
  };
}

function buildTestIdLocator(profile) {
  const { testId } = profile;
  if (!testId) return null;
  return {
    strategy: 'test_id',
    priority: STRATEGY_PRIORITY.test_id,
    score: 0,
    code: `page.getByTestId('${esc(testId)}')`,
    description: `testId=${testId}`,
  };
}

function buildLabelLocator(profile) {
  const label = profile.el.labelText || profile.el.label || profile.attrs?.['aria-label'];
  if (!label) return null;
  return {
    strategy: 'label',
    priority: STRATEGY_PRIORITY.label,
    score: 0,
    code: `page.getByLabel('${esc(label)}', { exact: false })`,
    description: `label="${label}"`,
  };
}

function buildPlaceholderLocator(profile) {
  const ph = profile.attrs?.placeholder;
  if (!ph) return null;
  return {
    strategy: 'placeholder',
    priority: STRATEGY_PRIORITY.placeholder,
    score: 0,
    code: `page.getByPlaceholder('${esc(ph)}', { exact: false })`,
    description: `placeholder="${ph}"`,
  };
}

function buildTextLocator(profile) {
  const text = (profile.el.text || '').trim();
  if (!text || text.length > 120) return null;
  return {
    strategy: 'text',
    priority: STRATEGY_PRIORITY.text,
    score: 0,
    code: `page.getByText('${esc(text)}', { exact: false })`,
    description: `text="${text.slice(0, 40)}"`,
  };
}

function buildAltTextLocator(profile) {
  const alt = profile.attrs?.alt;
  if (!alt) return null;
  return {
    strategy: 'alt_text',
    priority: STRATEGY_PRIORITY.alt_text,
    score: 0,
    code: `page.getByAltText('${esc(alt)}', { exact: false })`,
    description: `alt="${alt}"`,
  };
}

function buildTitleLocator(profile) {
  const title = profile.attrs?.title;
  if (!title) return null;
  return {
    strategy: 'title',
    priority: STRATEGY_PRIORITY.title,
    score: 0,
    code: `page.getByTitle('${esc(title)}', { exact: false })`,
    description: `title="${title}"`,
  };
}

function buildNameAttrLocator(profile) {
  const name = profile.attrs?.name;
  if (!name) return null;
  return {
    strategy: 'name_attr',
    priority: STRATEGY_PRIORITY.name_attr,
    score: 0,
    code: `page.locator('[name="${esc(name)}"]')`,
    description: `name="${name}"`,
  };
}

function buildIdLocator(profile) {
  const id = profile.attrs?.id;
  if (!id || /^(react|ember|ng|mui)-/i.test(id)) return null;
  return {
    strategy: 'id',
    priority: STRATEGY_PRIORITY.id,
    score: 0,
    code: `page.locator('#${esc(id)}')`,
    description: `id="${id}"`,
  };
}

function buildHrefLocator(profile) {
  const href = profile.attrs?.href;
  if (!href || href === '#' || /^javascript:/i.test(href)) return null;
  return {
    strategy: 'href',
    priority: 96,
    score: 0,
    code: `page.locator('a[href="${esc(href)}"]')`,
    description: `href="${href.slice(0, 60)}"`,
  };
}

function linkMatchesText(el, linkText) {
  const search = elementSearchText(el).toLowerCase();
  const target = (linkText || '').toLowerCase().trim();
  if (!target) return false;
  if (search.includes(target)) return true;
  const words = target.split(/\s+/).filter((w) => w.length >= 2);
  return words.length > 0 && words.every((w) => search.includes(w));
}

/** Links, or button/card overlays (e.g. Google Shopping product tiles). */
function isOrdinalClickTarget(el) {
  if (!isClickable(el)) return false;
  const profile = normalizeElement(el);
  if (el.tag === 'a' || profile.role === 'link') return true;
  if (profile.role === 'button') return true;
  return false;
}

function buildTextRegexPattern(linkText) {
  const reBody = (linkText || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  return `/${reBody}/i`;
}

function compareDomPosition(a, b) {
  const ay = a.position?.y ?? a._captureIndex ?? 0;
  const by = b.position?.y ?? b._captureIndex ?? 0;
  if (ay !== by) return ay - by;
  return (a.position?.x ?? 0) - (b.position?.x ?? 0);
}

const { buildOrdinalLinkLocatorFallbacks } = require('../../utils/ordinalLinkStep');

/**
 * Pick the Nth link matching text in DOM order; prefer element-specific locators, then scoped .nth().
 * @param {number} ordinal — 1-based (2 = second link)
 * @param {string} linkText
 * @param {Array} elements — hybrid page elements
 * @returns {string[]} Playwright code candidates
 */
function generateOrdinalLinkCandidates(ordinal, linkText, elements) {
  const index = Math.max(0, ordinal - 1);
  const textWords = extractWords(linkText);
  const candidates = [];
  const seen = new Set();

  const add = (code) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    candidates.push(code);
  };

  const re = buildTextRegexPattern(linkText);

  const matchingTargets = (elements || [])
    .map((el, captureIndex) => ({ ...el, _captureIndex: captureIndex }))
    .filter((el) => isOrdinalClickTarget(el) && linkMatchesText(el, linkText))
    .sort(compareDomPosition);

  if (matchingTargets.length > 0) {
    const targetEl = matchingTargets[index];
    if (targetEl) {
      const profile = normalizeElement(targetEl);
      logger.info(
        `Ordinal link #${ordinal}: selected <${targetEl.tag} role=${profile.role}> `
        + `"${elementSearchText(targetEl).slice(0, 80)}" `
        + `(${matchingTargets.length} match(es) in DOM order)`,
      );

      const accessibleName = getAccessibleName(targetEl);
      if (accessibleName && accessibleName.length <= 200) {
        add(
          `await page.getByRole('${profile.role}', { name: ${JSON.stringify(accessibleName)}, exact: false }).click();`,
        );
      }

      if (profile.role === 'button') {
        add(`await page.getByRole('button', { name: ${re} }).nth(${index}).click();`);
        const ariaLabel = profile.attrs?.['aria-label'];
        if (ariaLabel) {
          const needle = esc(linkText.split(/\s+/).find((w) => w.length >= 3) || linkText);
          add(
            `await page.locator('[role="button"][aria-label*="${needle}"]').nth(${index}).click();`,
          );
          if (profile.attrs?.['aria-hidden'] === 'true') {
            add(
              `await page.locator('[role="button"][aria-label*="${needle}"]').nth(${index}).click({ force: true });`,
            );
          }
        }
      }

      const locs = buildLocatorStrategies(profile, textWords, linkText);
      const hrefLoc = buildHrefLocator(profile);
      if (hrefLoc) {
        hrefLoc.score = 1000;
        locs.unshift(hrefLoc);
      }

      for (const code of toCodeList(
        candidatesFromRanked(
          [{ profile, matchScore: 1, locators: locs }],
          (loc) => `${loc}.click()`,
          { maxCandidates: 8 },
        ),
      )) {
        add(code);
      }
    } else {
      logger.warning(
        `Ordinal link: ${matchingTargets.length} target(s) match "${linkText}", step asks for #${ordinal} — using .nth() fallbacks`,
      );
    }
  } else if ((elements || []).length > 0) {
    logger.warning(
      `Ordinal link: no captured links/buttons match "${linkText}" — using .nth() fallbacks`,
    );
  }

  for (const code of buildOrdinalLinkLocatorFallbacks(ordinal, linkText)) {
    add(code);
  }

  return candidates;
}

/**
 * Generate all applicable Playwright locators for an element (ordered by strategy priority).
 */
function buildLocatorStrategies(profile, targetWords, fieldName = '') {
  const strategies = [];
  const overlapName = biOverlap(targetWords, profile.nameWords);
  const overlapSearch = biOverlap(targetWords, profile.searchWords);
  const overlapTestId = biOverlap(targetWords, profile.testIdWords);
  const matchScore = Math.max(overlapName, overlapSearch, overlapTestId);

  if (fieldName && abbreviationMatch(fieldName, profile.testId)) {
    // boost abbreviation matches (fname → firstName)
  }

  const add = (loc, overlap) => {
    if (!loc) return;
    const abbrBoost = fieldName && (
      abbreviationMatch(fieldName, profile.testId)
      || abbreviationMatch(fieldName, profile.attrs?.name)
      || abbreviationMatch(fieldName, profile.attrs?.id)
    ) ? 0.12 : 0;

    loc.score = matchScore * 40 + overlap * 30 + loc.priority * 0.3 + abbrBoost * 100;
    strategies.push(loc);
  };

  if (overlapName >= 0.45 || overlapSearch >= 0.5) {
    add(buildRoleNameLocator(profile), overlapName);
  }
  if (overlapTestId >= 0.4 || (profile.testId && overlapSearch >= 0.45)) {
    add(buildTestIdLocator(profile), overlapTestId);
  }
  if (overlapSearch >= 0.4) {
    add(buildLabelLocator(profile), overlapSearch);
    add(buildPlaceholderLocator(profile), overlapSearch);
    add(buildAltTextLocator(profile), overlapSearch);
    add(buildTitleLocator(profile), overlapSearch);
    if (overlapName < 0.55) {
      add(buildTextLocator(profile), overlapSearch);
    }
  }
  if (overlapSearch >= 0.55) {
    add(buildNameAttrLocator(profile), overlapSearch);
    add(buildHrefLocator(profile), overlapSearch);
    if (overlapTestId < 0.7) {
      add(buildIdLocator(profile), overlapSearch);
    }
  }

  return strategies.sort((a, b) => b.score - a.score);
}

/**
 * Rank page elements for a natural-language target.
 * @returns {Array<{ profile, matchScore, locators }>}
 */
function rankElementsForTarget(target, elements, intent = 'click', options = {}) {
  const targetWords = extractWords(target);
  const minMatch = options.minMatch ?? 0.38;
  const filtered = filterByIntent(elements, intent)
    .filter((el) => isVisibleEnough(el) && !isDisabled(el))
    .map(normalizeElement);

  const ranked = [];

  for (const profile of filtered) {
    const overlapName = biOverlap(targetWords, profile.nameWords);
    const overlapSearch = biOverlap(targetWords, profile.searchWords);
    const overlapTestId = biOverlap(targetWords, profile.testIdWords);
    const matchScore = Math.max(overlapName, overlapSearch, overlapTestId);

    if (matchScore < minMatch) continue;

    const locators = buildLocatorStrategies(profile, targetWords, target);
    if (locators.length === 0) continue;

    ranked.push({ profile, matchScore, locators });
  }

  ranked.sort((a, b) => {
    const bestA = a.locators[0]?.score || 0;
    const bestB = b.locators[0]?.score || 0;
    return bestB - bestA;
  });

  return ranked;
}

/**
 * Flatten ranked elements into executable candidate strings.
 */
function candidatesFromRanked(ranked, actionFn, options = {}) {
  const { maxCandidates = 12, tryCatch = false, timeout = 5000 } = options;
  const seen = new Set();
  const results = [];

  for (const { locators } of ranked) {
    for (const loc of locators) {
      const action = actionFn(loc.code);
      if (seen.has(action)) continue;
      seen.add(action);
      const code = tryCatch
        ? `try { await ${action}; } catch(e) { /* optional */ }`
        : `await ${action};`;
      results.push({ code, score: loc.score, strategy: loc.strategy });
      if (results.length >= maxCandidates) return results.sort((a, b) => b.score - a.score);
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Score element relevance for pre-filtering (used by elementFiltering.js).
 */
function scoreElementRelevance(stepDescription, el) {
  const targetWords = extractWords(stepDescription);
  const profile = normalizeElement(el);
  let score = 0;

  const overlap = Math.max(
    biOverlap(targetWords, profile.nameWords),
    biOverlap(targetWords, profile.searchWords),
    biOverlap(targetWords, profile.testIdWords),
  );
  score += Math.round(overlap * 80);

  if (profile.testId && targetWords.some((w) => profile.testIdWords.includes(w))) score += 25;
  if (profile.visible) score += 5;
  if (profile.disabled) score -= 50;

  const desc = stepDescription.toLowerCase();
  const role = profile.role || '';
  if (/click|press|tap/.test(desc) && ['button', 'link', 'tab', 'menuitem'].includes(role)) score += 20;
  if (/fill|enter|type|input/.test(desc) && ['textbox', 'searchbox', 'combobox'].includes(role)) score += 20;
  if (/select|choose|pick/.test(desc) && role === 'combobox') score += 20;
  if (/check|uncheck|tick/.test(desc) && role === 'checkbox') score += 20;
  if (/valid|verify|assert|visible|displayed/.test(desc)) score += 10;

  return score;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((c) => {
    const key = typeof c === 'string' ? c : c.code;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toCodeList(candidates) {
  return dedupeCandidates(candidates)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .map((c) => (typeof c === 'string' ? c : c.code));
}

module.exports = {
  NOISE_WORDS,
  STRATEGY_PRIORITY,
  normalizeStep,
  extractWords,
  biOverlap,
  wordOverlap,
  editDistance,
  abbreviationMatch,
  fieldAbbreviations,
  generateOrdinalLinkCandidates,
  linkMatchesText,
  isOrdinalClickTarget,
  buildTextRegexPattern,
  esc,
  getTestId,
  getImplicitRole,
  getAccessibleName,
  normalizeElement,
  elementSearchText,
  isInputField,
  isClickable,
  isSelectField,
  isCheckbox,
  isDisabled,
  isVisibleEnough,
  filterByIntent,
  buildLocatorStrategies,
  rankElementsForTarget,
  candidatesFromRanked,
  scoreElementRelevance,
  dedupeCandidates,
  toCodeList,
};
