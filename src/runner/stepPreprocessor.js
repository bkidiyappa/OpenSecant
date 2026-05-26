/**
 * Step preprocessor module
 * Handles: @reuse expansion, {{env.x}} substitution, {{keyword}} dynamic data
 *
 * Processing order:
 *   1. Expand @reuse directives (inline steps from referenced .test files)
 *   2. Substitute {{env.x}} placeholders with environment config values
 *   3. Substitute {{keyword}} directives with generated dynamic values
 *
 * Returns both the original step text and the resolved text for reporting.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const env = require('../config/envConfig');
const { generateUniqueAlphabeticString } = require('../utils/uniqueStringGenerator');

const TESTS_DIR = path.join(__dirname, '../../tests');

// ── Dynamic data keyword generators ──────────────────────────────────────────
const KEYWORD_GENERATORS = {
  // {{unique}} — timestamp-based unique alphabetic string (e.g. CACBADBC...)
  unique: () => generateUniqueAlphabeticString(),

  // {{timestamp}} — Unix timestamp in ms
  timestamp: () => Date.now().toString(),

  // {{date}} — today's date as YYYY-MM-DD
  date: () => new Date().toISOString().split('T')[0],

  // {{datetime}} — ISO datetime string
  datetime: () => new Date().toISOString(),

  // {{random_number}} — random 6-digit number
  random_number: () => Math.floor(100000 + Math.random() * 900000).toString(),

  // {{random_phone}} — random US phone format (xxx) xxx-xxxx
  random_phone: () => {
    const d = () => Math.floor(Math.random() * 10);
    return `(${d()}${d()}${d()}) ${d()}${d()}${d()}-${d()}${d()}${d()}${d()}`;
  },

  // {{random_email}} — random email address
  random_email: () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let name = '';
    for (let i = 0; i < 8; i++) name += chars[Math.floor(Math.random() * chars.length)];
    return `${name}@example.com`;
  },

  // {{random_name}} — random first name from a small pool
  random_name: () => {
    const names = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Parker', 'Drew'];
    return names[Math.floor(Math.random() * names.length)];
  },

  // {{uuid}} — simple UUID v4
  uuid: () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
};

/**
 * Resolve a nested property from an object using dot notation.
 * e.g. resolveProperty(env, 'credentials.email') → env.credentials.email
 */
function resolveProperty(obj, propertyPath) {
  const parts = propertyPath.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Substitute {{env.xxx}} placeholders with environment config values.
 * Supports nested properties: {{env.credentials.email}}
 */
function substituteEnvVars(text) {
  return text.replace(/\{\{env\.([a-zA-Z0-9_.]+)\}\}/g, (match, propPath) => {
    const value = resolveProperty(env, propPath);
    if (value === undefined) {
      logger.warning(`[PREPROCESS] Unknown env property: {{env.${propPath}}}`);
      return match; // leave unresolved
    }
    return String(value);
  });
}

/**
 * Substitute {{keyword}} directives with dynamically generated values.
 * Supports: {{unique}}, {{timestamp}}, {{date}}, {{random_number}}, etc.
 * Also supports {{random_N}} for a random N-digit number.
 */
function substituteKeywords(text) {
  return text.replace(/\{\{([a-zA-Z_]+(?:_\d+)?)\}\}/g, (match, keyword) => {
    // Check exact keyword match
    if (KEYWORD_GENERATORS[keyword]) {
      return KEYWORD_GENERATORS[keyword]();
    }

    // Check pattern: random_N → generate N-digit random number
    const randomDigitMatch = keyword.match(/^random_(\d+)$/);
    if (randomDigitMatch) {
      const digits = parseInt(randomDigitMatch[1], 10);
      if (digits > 0 && digits <= 15) {
        const min = Math.pow(10, digits - 1);
        const max = Math.pow(10, digits) - 1;
        return Math.floor(min + Math.random() * (max - min + 1)).toString();
      }
    }

    // Not a known keyword — leave as-is (might be {{env.x}} already handled)
    return match;
  });
}

/**
 * Read steps from a .test file (for @reuse expansion).
 * Returns an array of raw step strings (no test header, no tags).
 */
function readTestSteps(testFileName) {
  // Search in tests/ directory and all subdirectories
  const candidates = [
    path.join(TESTS_DIR, testFileName),
    path.join(TESTS_DIR, 'smoke', testFileName),
    path.join(TESTS_DIR, 'regression', testFileName),
    path.join(TESTS_DIR, 'shared', testFileName),
    path.join(TESTS_DIR, 'functions', testFileName),
  ];

  let filePath = null;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  // Also try recursive search if not found in standard locations
  if (!filePath) {
    filePath = findFileRecursive(TESTS_DIR, testFileName);
  }

  if (!filePath) {
    logger.error(`[PREPROCESS] @reuse file not found: ${testFileName}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  const steps = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip test header, tags, and @reuse directives within reused files
    if (trimmed.startsWith('Test:') || trimmed.startsWith('@')) continue;
    // Strip leading step numbers (e.g. "1. Click button" → "Click button")
    const cleaned = trimmed.replace(/^\d+\.\s*/, '').trim();
    if (cleaned) steps.push(cleaned);
  }

  return steps;
}

/**
 * Recursively find a file by name under a directory.
 */
function findFileRecursive(dir, fileName) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isFile() && item.name === fileName) return fullPath;
      if (item.isDirectory()) {
        const found = findFileRecursive(fullPath, fileName);
        if (found) return found;
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Preprocess an array of raw steps:
 *   1. Expand @reuse directives
 *   2. Substitute {{env.x}} and {{keyword}} placeholders
 *
 * Returns an array of { original, resolved, source } objects.
 *   - original: the step as written in the test file
 *   - resolved: the step with all substitutions applied
 *   - source:   'inline' or 'reuse:<filename>'
 */
function preprocessSteps(steps) {
  const result = [];

  for (const step of steps) {
    const trimmed = step.replace(/^\d+\.\s*/, '').trim();

    // ── @reuse expansion ─────────────────────────────────────────────────
    if (trimmed.toLowerCase().startsWith('@reuse ')) {
      const testFileName = trimmed.substring(7).trim();
      logger.info(`[PREPROCESS] Expanding @reuse ${testFileName}`);
      const reusedSteps = readTestSteps(testFileName);

      if (reusedSteps.length === 0) {
        logger.warning(`[PREPROCESS] @reuse ${testFileName} — no steps found`);
        result.push({
          original: step,
          resolved: step,
          source: `reuse:${testFileName}`,
          isReuse: true,
          reuseFailed: true
        });
        continue;
      }

      logger.info(`[PREPROCESS] @reuse ${testFileName} — expanded ${reusedSteps.length} steps`);

      for (const reusedStep of reusedSteps) {
        const resolved = substituteKeywords(substituteEnvVars(reusedStep));
        result.push({
          original: reusedStep,
          resolved,
          source: `reuse:${testFileName}`,
          isReuse: true
        });
      }
      continue;
    }

    // ── Normal step — apply substitutions ────────────────────────────────
    const resolved = substituteKeywords(substituteEnvVars(trimmed));
    result.push({
      original: step,
      resolved,
      source: 'inline'
    });
  }

  // Log substitution summary
  const substituted = result.filter(r => r.original !== r.resolved);
  if (substituted.length > 0) {
    logger.info(`[PREPROCESS] ${substituted.length} step(s) had variable substitutions`);
    for (const s of substituted) {
      logger.info(`[PREPROCESS]   "${s.original}" → "${s.resolved}"`);
    }
  }

  return result;
}

module.exports = {
  preprocessSteps,
  substituteEnvVars,
  substituteKeywords,
  KEYWORD_GENERATORS
};
