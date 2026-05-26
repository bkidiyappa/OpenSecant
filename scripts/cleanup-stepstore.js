/**
 * Maintenance script — remove orphaned entries from stepstore.json
 *
 * Scans all .test files under tests/.
 * Any stepstore key not referenced by at least one file is removed.
 *
 * Usage:
 *   node scripts/cleanup-stepstore.js            (dry-run, shows what would be removed)
 *   node scripts/cleanup-stepstore.js --apply     (actually removes orphans)
 */
const fs = require('fs');
const path = require('path');
const { normalizeStep } = require('../src/store/stepStore');

const STORE_PATH = path.join(__dirname, '..', 'data', 'stepstore.json');
const TESTS_DIR = path.join(__dirname, '..', 'tests');

/**
 * Recursively find all files matching given extensions
 */
function findFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, extensions));
    } else if (extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Extract normalized step texts from a .test file
 */
function extractTestSteps(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line || line.startsWith('Test:')) return false;
      // Keep @reuse lines (they're step directives), skip other @ lines (tags)
      if (line.toLowerCase().startsWith('@reuse')) return false; // @reuse steps are expanded, not in stepstore
      if (line.startsWith('@')) return false;
      return true;
    })
    .map(line => normalizeStep(line));
}

// ── Main ────────────────────────────────────────────────────────────────────

const applyMode = process.argv.includes('--apply');

if (!fs.existsSync(STORE_PATH)) {
  console.log('stepstore.json not found.');
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
const storeKeys = new Set(Object.keys(store));

// Collect all referenced steps from .test and .function files
const referencedSteps = new Set();

const testFiles = findFiles(TESTS_DIR, ['.test']);

for (const file of testFiles) {
  for (const step of extractTestSteps(file)) {
    referencedSteps.add(step);
  }
}

// Find orphans — keys in store not referenced by any file
const orphans = [];
for (const key of storeKeys) {
  if (!referencedSteps.has(key)) {
    orphans.push(key);
  }
}

console.log(`\nStepStore: ${storeKeys.size} entries`);
console.log(`Test files: ${testFiles.length}`);
console.log(`Referenced steps: ${referencedSteps.size}`);
console.log(`Orphaned entries: ${orphans.length}\n`);

if (orphans.length === 0) {
  console.log('Nothing to clean up.');
  process.exit(0);
}

for (const key of orphans) {
  const codePreview = store[key].substring(0, 80) + (store[key].length > 80 ? '...' : '');
  console.log(`  - "${key}"  →  ${codePreview}`);
}

if (applyMode) {
  for (const key of orphans) {
    delete store[key];
  }
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  console.log(`\n✓ Removed ${orphans.length} orphaned entries. ${Object.keys(store).length} entries remaining.`);
} else {
  console.log(`\nDry run — no changes made. Run with --apply to remove orphans.`);
}
