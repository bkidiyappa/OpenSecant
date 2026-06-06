/**
 * Test reader module - Functions for reading and parsing test files
 */
const fs = require('fs');
const path = require('path');

function readTestCase(testCasePath) {
  const content = fs.readFileSync(testCasePath, 'utf8');
  const lines = content.split('\n').filter((line) => line.trim() !== '');

  const tagLine = lines.find((line) => line.trim().startsWith('@') && !line.trim().toLowerCase().startsWith('@reuse'));
  const tags = tagLine
    ? tagLine.trim().split(' ').filter((tag) => tag.startsWith('@')).map((tag) => tag.substring(1))
    : [];

  const hasTestHeader = lines.length > 0 && lines[0].trim().startsWith('Test:');
  const testName = hasTestHeader
    ? lines[0].replace('Test:', '').trim()
    : path.basename(testCasePath, path.extname(testCasePath));

  const numberedSteps = lines.filter((line) => /^\d+\./.test(line.trim())).map((line) => line.trim());

  let steps;
  let isNumberedFormat = false;
  if (numberedSteps.length > 0) {
    steps = numberedSteps;
    isNumberedFormat = true;
  } else {
    const rawSteps = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('@reuse')) {
        rawSteps.push(trimmed);
        continue;
      }
      if (trimmed.startsWith('@') || (hasTestHeader && trimmed === lines[0].trim())) continue;
      rawSteps.push(trimmed);
    }

    const stepCounts = {};
    steps = rawSteps.map((step) => {
      const lowerStep = step.toLowerCase();
      stepCounts[lowerStep] = (stepCounts[lowerStep] || 0) + 1;
      const occurrence = stepCounts[lowerStep];
      const totalOccurrences = rawSteps.filter((s) => s.toLowerCase() === lowerStep).length;
      if (totalOccurrences > 1) {
        return `${step} #${occurrence}`;
      }
      return step;
    });
  }

  return { testName, steps, tags, isNumberedFormat };
}

function findTestFiles(directory) {
  let testFiles = [];
  const items = fs.readdirSync(directory, { withFileTypes: true });

  for (const item of items) {
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) {
      testFiles = testFiles.concat(findTestFiles(itemPath));
    } else if (item.isFile() && item.name.endsWith('.test')) {
      testFiles.push(itemPath);
    }
  }

  return testFiles;
}

/**
 * Normalize a CLI test specifier to a .test basename.
 * @param {string} spec
 * @returns {string}
 */
function normalizeTestSpec(spec) {
  let name = (spec || '').trim().replace(/\\/g, '/');
  if (!name) return '';
  if (name.endsWith('.test')) return name;
  if (!name.includes('/')) return `${name}.test`;
  return name.endsWith('.test') ? name : `${name}.test`;
}

/**
 * Resolve one or more test specifiers to absolute file paths under tests/.
 * @param {string[]} specs — e.g. "search", "smoke/search", "smoke/search.test"
 * @param {string} testDir — root tests directory
 * @returns {{ paths: string[], errors: string[] }}
 */
function resolveTestPaths(specs, testDir) {
  const paths = [];
  const errors = [];

  for (const spec of specs) {
    const normalized = normalizeTestSpec(spec);
    if (!normalized) {
      errors.push('(empty test name)');
      continue;
    }

    const directPath = path.isAbsolute(normalized)
      ? normalized
      : path.join(testDir, normalized);

    if (fs.existsSync(directPath)) {
      paths.push(path.resolve(directPath));
      continue;
    }

    const baseName = path.basename(normalized);
    const allTests = findTestFiles(testDir);
    const matches = allTests.filter((f) => path.basename(f) === baseName);

    if (matches.length === 1) {
      paths.push(path.resolve(matches[0]));
      continue;
    }

    if (matches.length > 1) {
      const relative = matches.map((f) => path.relative(testDir, f).replace(/\\/g, '/'));
      errors.push(
        `"${spec}" is ambiguous (${matches.length} files). Use a path, e.g.: ${relative.join(' or ')}`
      );
      continue;
    }

    errors.push(`"${spec}" — no .test file found under ${testDir}`);
  }

  return { paths, errors };
}

function getTestFilesByTag(tag) {
  const testDir = path.join(__dirname, '../../tests');

  if (tag.toLowerCase() === 'smoke') {
    const smokeDir = path.join(testDir, 'smoke');
    if (fs.existsSync(smokeDir)) {
      return findTestFiles(smokeDir);
    }
  }

  const allTestFiles = findTestFiles(testDir);
  const matchingTests = [];

  for (const testFile of allTestFiles) {
    try {
      const content = fs.readFileSync(testFile, 'utf8');
      for (const line of content.split('\n')) {
        if (line.includes(`@${tag}`)) {
          matchingTests.push(testFile);
          break;
        }
      }
    } catch (error) {
      console.error(`Error reading file ${testFile}: ${error.message}`);
    }
  }

  return matchingTests;
}

module.exports = {
  readTestCase,
  findTestFiles,
  getTestFilesByTag,
  normalizeTestSpec,
  resolveTestPaths,
};
