/**
 * Step Store — simple step → playwright code map
 * 
 * Flat key-value store: normalized step text → playwright code string.
 * Supports fuzzy matching with action verb synonyms for cross-test reuse.
 * File: data/stepstore.json
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { isOrdinalLinkStepCodeValid } = require('../utils/ordinalLinkStep');

const STORE_PATH = path.join(__dirname, '../../data/stepstore.json');

/**
 * Normalize step text for matching
 * Strips step numbers, #N suffixes, extra whitespace, lowercases
 */
function normalizeStep(step) {
  return step
    .replace(/^\d+\.\s*/, '')      // strip leading "1. "
    .replace(/\s*#\d+$/, '')       // strip trailing " #1"
    .replace(/["']/g, '')          // strip quotes (LLM may add them around values)
    .replace(/\s+/g, ' ')         // collapse whitespace
    .trim()
    .toLowerCase();
}

/**
 * Action verb synonym groups — treated as equivalent in matching
 */
const VERB_SYNONYMS = {
  click: ['click', 'press', 'tap', 'hit'],
  fill: ['fill', 'enter', 'type', 'input', 'write', 'set'],
  select: ['select', 'choose', 'pick'],
  check: ['check', 'tick', 'enable'],
  uncheck: ['uncheck', 'untick', 'disable'],
  verify: ['verify', 'assert', 'confirm', 'ensure', 'validate', 'expect'],
  wait: ['wait', 'pause', 'delay'],
  open: ['open', 'navigate', 'go', 'visit', 'browse', 'load'],
  scroll: ['scroll', 'swipe'],
  hover: ['hover', 'mouseover'],
};

// Reverse lookup: word → canonical verb
const SYNONYM_MAP = {};
for (const [canonical, synonyms] of Object.entries(VERB_SYNONYMS)) {
  for (const syn of synonyms) {
    SYNONYM_MAP[syn] = canonical;
  }
}

function canonicalize(token) {
  return SYNONYM_MAP[token] || token;
}

/**
 * Extract semantic tokens from a step for fuzzy matching
 */
function extractTokens(step) {
  const stopWords = new Set([
    'a', 'an', 'the', 'on', 'in', 'to', 'for', 'of', 'and', 'or', 'is', 'as',
    'into', 'from', 'with', 'that', 'which', 'this', 'it', 'its', 'be', 'are'
  ]);
  return normalizeStep(step)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !stopWords.has(t));
}

/**
 * Extract the field name from a fill/enter/type/set step.
 * Returns the field portion or null if step is not a field-action.
 * e.g. "fill first name as Alex" → "first name"
 *      "enter foo into last name" → "last name"
 */
function extractFieldName(normalizedStep) {
  const fillMatch = normalizedStep.match(/^(?:fill|set)\s+(?:the\s+)?(.+?)\s+(?:as|with|to)\s+/i);
  if (fillMatch) return fillMatch[1].trim();
  const enterMatch = normalizedStep.match(/^(?:enter|type|input)\s+.+?\s+(?:in\s*to|in|to)\s+(?:the\s+)?(.+)$/i);
  if (enterMatch) return enterMatch[1].trim();
  return null;
}

/**
 * Extract value and field from a select step.
 * Returns { value, field } or null if not a select-action.
 * e.g. "select residential from service type" → { value: "residential", field: "service type" }
 *      "select email from how did you hear about us" → { value: "email", field: "how did you hear about us" }
 */
function extractSelectParts(normalizedStep) {
  const fromMatch = normalizedStep.match(/^(?:select|choose|pick)\s+(.+?)\s+(?:from|in)\s+(?:the\s+)?(.+)$/i);
  if (fromMatch) return { value: fromMatch[1].trim(), field: fromMatch[2].trim() };
  const asMatch = normalizedStep.match(/^(?:select)\s+(.+?)\s+as\s+(.+)$/i);
  if (asMatch) return { value: asMatch[2].trim(), field: asMatch[1].trim() };
  return null;
}

/**
 * Compute similarity between two steps (0-1)
 */
function stepSimilarity(stepA, stepB) {
  const tokensA = extractTokens(stepA).map(canonicalize);
  const tokensB = extractTokens(stepB).map(canonicalize);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  // Guard: for fill/enter/type steps, reject match if field names differ
  const fieldA = extractFieldName(normalizeStep(stepA));
  const fieldB = extractFieldName(normalizeStep(stepB));
  if (fieldA && fieldB && fieldA !== fieldB) {
    return 0;
  }

  // Guard: for select steps, reject match if field OR value differs
  const selA = extractSelectParts(normalizeStep(stepA));
  const selB = extractSelectParts(normalizeStep(stepB));
  if (selA && selB) {
    if (selA.field !== selB.field || selA.value !== selB.value) {
      return 0;
    }
  }

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }

  const union = new Set([...setA, ...setB]).size;
  const jaccard = intersection / union;

  const actionVerbs = new Set(Object.keys(VERB_SYNONYMS));
  const verbA = tokensA.find(t => actionVerbs.has(t));
  const verbB = tokensB.find(t => actionVerbs.has(t));
  const verbBoost = (verbA && verbA === verbB) ? 0.15 : 0;
  const verbPenalty = (verbA && verbB && verbA !== verbB) ? -0.2 : 0;

  return Math.max(0, Math.min(1, jaccard + verbBoost + verbPenalty));
}

class StepStore {
  constructor(storePath = STORE_PATH) {
    this.storePath = storePath;
    this.data = {};   // { "normalized step": "playwright code" }
    this.load();
  }

  /**
   * Read current persisted map (workers may bypass this.data; always fresh from disk when possible).
   * @returns {Record<string,string>}
   */
  readDisk() {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf8');
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { ...parsed };
        }
      }
    } catch (err) {
      logger.warning(`Step store disk read skipped (merge): ${err.message}`);
    }
    return {};
  }

  /**
   * @param {Record<string,string>} merged
   */
  writeDisk(merged) {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.storePath, JSON.stringify(merged, null, 2), 'utf8');
  }

  load() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.data = this.readDisk();
        logger.info(`Step store loaded: ${Object.keys(this.data).length} steps`);
      } else {
        this.data = {};
        logger.info('Step store not found, starting fresh');
      }
    } catch (err) {
      logger.error(`Failed to load step store: ${err.message}`);
    }
  }

  save() {
    try {
      const merged = { ...this.readDisk(), ...this.data };
      this.data = merged;
      this.writeDisk(merged);
    } catch (err) {
      logger.error(`Failed to save step store: ${err.message}`);
    }
  }

  /**
   * Look up playwright code for a step.
   * Reads disk if missing in memory so parallel workers pick up mappings saved by sibling workers.
   * Exact key match only — no fuzzy matching here.
   */
  resolve(stepText) {
    const normalized = normalizeStep(stepText);
    if (this.data[normalized]) {
      return this.data[normalized];
    }
    const disk = this.readDisk();
    if (disk[normalized]) {
      this.data[normalized] = disk[normalized];
      return disk[normalized];
    }
    return null;
  }

  /**
   * Store a step → code mapping (merges with latest disk state so parallel workers do not wipe each other's entries).
   */
  set(stepText, code) {
    if (!isOrdinalLinkStepCodeValid(stepText, code)) {
      logger.warning(
        `StepStore: not caching code for "${stepText}" — ordinal link code must use .nth(N) where N = ordinal−1, or element-specific href/testid`,
      );
      return;
    }
    const normalized = normalizeStep(stepText);
    const RETRIES = 6;
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const merged = this.readDisk();
        merged[normalized] = code;
        this.data = merged;
        this.writeDisk(merged);
        return;
      } catch (err) {
        if (attempt === RETRIES - 1) {
          logger.error(`Failed to save step store after ${RETRIES} attempts: ${err.message}`);
          return;
        }
        const ms = 5 + Math.floor(Math.random() * 20) + attempt * 8;
        const until = Date.now() + ms;
        while (Date.now() < until) {
          /* sync backoff for contention on stepstore.json */
        }
      }
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return { steps: Object.keys(this.data).length };
  }

  /**
   * Migrate from legacy selectors.json (one-time)
   */
  migrateFromSelectorsJson(selectorsPath) {
    try {
      if (!fs.existsSync(selectorsPath)) return 0;
      const selectorsData = JSON.parse(fs.readFileSync(selectorsPath, 'utf8'));
      let migrated = 0;

      for (const [, steps] of Object.entries(selectorsData)) {
        for (const [stepText, config] of Object.entries(steps)) {
          if (config.playwright_code) {
            const normalized = normalizeStep(stepText);
            if (!this.data[normalized]) {
              this.data[normalized] = config.playwright_code;
              migrated++;
            }
          }
        }
      }

      if (migrated > 0) this.save();
      logger.info(`Migrated ${migrated} steps from selectors.json`);
      return migrated;
    } catch (err) {
      logger.error(`Migration failed: ${err.message}`);
      return 0;
    }
  }
}

// Singleton
let instance = null;

function getStepStore() {
  if (!instance) {
    instance = new StepStore();
  }
  return instance;
}

module.exports = {
  StepStore,
  getStepStore,
  normalizeStep,
  stepSimilarity
};
