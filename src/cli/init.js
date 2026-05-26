/**
 * CLI: scaffold a new OpenSecant project layout.
 */
const fs = require('fs');
const path = require('path');

function initProject(targetDir = process.cwd()) {
  const dirs = [
    'tests/smoke',
    'tests/regression',
    'tests/ai',
    'tests/fixtures',
    'data',
    'reports',
    'examples/qa-agent',
  ];

  for (const dir of dirs) {
    const full = path.join(targetDir, dir);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(full, { recursive: true });
    }
  }

  const stepStorePath = path.join(targetDir, 'data', 'stepstore.json');
  if (!fs.existsSync(stepStorePath)) {
    fs.writeFileSync(stepStorePath, '{}\n', 'utf8');
  }

  console.log('OpenSecant project scaffold created.');
  console.log('Next: copy src/config/envConfig.example.js to envConfig.js and add tests under tests/');
}

module.exports = { initProject };
