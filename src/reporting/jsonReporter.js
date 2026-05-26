/**
 * JSON test report writer.
 */
const fs = require('fs');
const path = require('path');

function writeJsonReport(runDir, testName, payload) {
  const filePath = path.join(runDir, `${testName.replace(/\.test$/, '')}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

module.exports = {
  writeJsonReport,
};
