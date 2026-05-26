/**
 * Load .env from project root into process.env (does not override existing vars).
 */
const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
  const file = envPath || path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(file)) return false;

  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

module.exports = loadEnv;
