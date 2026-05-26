const fs = require('fs');
const path = require('path');
const env = require('../config/envConfig');

// Function to generate timestamp string in IST timezone
function getTimestamp() {
  const now = new Date();
  // Convert to IST timezone (UTC+5:30)
  const options = { timeZone: 'Asia/Kolkata', hour12: false };
  const istDate = now.toLocaleString('en-US', options);
  
  // Format: YYYYMMDD_HHMMSS
  const parts = istDate.split(', ');
  const datePart = parts[0].split('/');
  const timePart = parts[1].split(':');
  
  // Convert to YYYYMMDD_HHMMSS format
  const month = datePart[0].padStart(2, '0');
  const day = datePart[1].padStart(2, '0');
  const year = datePart[2];
  const hours = timePart[0].padStart(2, '0');
  const minutes = timePart[1].padStart(2, '0');
  const seconds = timePart[2].padStart(2, '0');
  
  return `${year}${month}${day}_${hours}${minutes}${seconds}_IST`;
}

// Function to create a timestamped run directory
function createRunDirectory() {
  const timestamp = getTimestamp();
  const reportsBaseDir = path.join(__dirname, '..', '..', 'reports');
  if (!fs.existsSync(reportsBaseDir)) {
    fs.mkdirSync(reportsBaseDir);
  }
  
  const runDir = path.join(reportsBaseDir, timestamp);
  if (!fs.existsSync(runDir)) {
    fs.mkdirSync(runDir);
  }
  
  // Create screenshots directory within the run directory
  const screenshotsDir = path.join(runDir, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir);
  }
  
  return { runDir, screenshotsDir, timestamp, reportsBaseDir };
}

// Function to create HTML report header
function createHtmlReportHeader(testName, startTime) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Report: ${testName}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #333; }
    .summary-container { display: flex; justify-content: space-between; flex-wrap: wrap; }
    .summary-column { background-color: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; flex: 1; margin-right: 10px; min-width: 200px; }
    .summary-column:last-child { margin-right: 0; }
    .summary-column h3 { margin-top: 0; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
    .pass { color: green; }
    .fail { color: red; }
    .step { margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 5px; }
    .step-header { display: flex; justify-content: space-between; }
    .step-name { font-weight: bold; }
    .step-status { font-weight: bold; }
    .step-resolved { margin-top: 5px; color: #555; font-size: 0.9em; }
    .step-resolved code { background: #e8f4e8; padding: 2px 6px; border-radius: 3px; color: #2d6a2d; }
    .step-details { margin-top: 10px; }
    .screenshot { margin-top: 10px; padding: 8px; background: #fafafa; border: 1px solid #e0e0e0; border-radius: 4px; }
    .screenshot-label { font-size: 0.85em; color: #666; margin-bottom: 6px; font-weight: bold; }
    .screenshot-label.fail-label { color: #c0392b; }
    .screenshot-label.last-label { color: #2980b9; }
    .screenshot img { max-width: 100%; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Test Report: ${testName}</h1>
  <div class="summary-container">
    <div class="summary-column">
      <h3>Time Information</h3>
      <p><strong>Start Time:</strong> ${startTime}</p>
      <p><strong>End Time:</strong> <span id="end-time">Running...</span></p>
      <p><strong>Duration:</strong> <span id="duration">Calculating...</span></p>
    </div>
    <div class="summary-column">
      <h3>Test Statistics</h3>
      <p><strong>Environment:</strong> ${env.currentEnv}</p>
      <p><strong>Total Steps:</strong> <span id="total-steps">0</span></p>
      <p><strong>Passed:</strong> <span class="pass" id="passed-steps">0</span></p>
      <p><strong>Failed:</strong> <span class="fail" id="failed-steps">0</span></p>
    </div>
    <div class="summary-column">
      <h3>Execution Details</h3>
      <p><strong>Command:</strong> <span id="command">node runner.js ${testName}</span></p>
      <p><strong>Test Name:</strong> ${testName}</p>
    </div>
  </div>
  <h2>Test Steps</h2>
`;
}

// Function to create HTML report footer
function createHtmlReportFooter(status, endTime, durationSeconds, totalSteps = 0, passedSteps = 0, failedSteps = 0, command = '') {
  // Calculate duration in minutes
  const durationMinutes = (durationSeconds / 60).toFixed(2);
  const statusClass = status === 'PASS' ? 'pass' : 'fail';
  return `
  <div class="summary-container">
    <div class="summary-column">
      <h3>Final Status</h3>
      <p><strong>Status:</strong> <span class="${statusClass}">${status}</span></p>
    </div>
  </div>
  
  <script>
    // Update dynamic elements
    document.getElementById('end-time').textContent = '${endTime}';
    document.getElementById('duration').textContent = '${durationMinutes} minutes (${durationSeconds} seconds)';
    document.getElementById('total-steps').textContent = '${totalSteps}';
    document.getElementById('passed-steps').textContent = '${passedSteps}';
    document.getElementById('failed-steps').textContent = '${failedSteps}';
    if ('${command}') {
      document.getElementById('command').textContent = '${command}';
    }
  </script>
</body>
</html>
`;
}

// Function to add step to HTML report
// resolvedStep: if provided, shows the resolved value (after {{env}}/{{keyword}} substitution)
function addStepToHtmlReport(stepName, status, details = '', screenshotPath = null, resolvedStep = null) {
  const statusClass = status === 'PASS' ? 'pass' : 'fail';
  let html = `
  <div class="step">
    <div class="step-header">
      <span class="step-name">${stepName}</span>
      <span class="step-status ${statusClass}">${status}</span>
    </div>`;
  
  // Show resolved value when it differs from the original step
  if (resolvedStep) {
    html += `
    <div class="step-resolved">
      <em>Resolved:</em> <code>${resolvedStep}</code>
    </div>`;
  }

  if (details) {
    html += `
    <div class="step-details">
      <pre>${details}</pre>
    </div>`;
  }
  
  if (screenshotPath) {
    const relativePath = screenshotPath.includes('screenshots/') ? screenshotPath : path.basename(screenshotPath);
    const isFail = status === 'FAIL';
    const labelClass = isFail ? 'fail-label' : 'last-label';
    const labelText = isFail ? '📸 Failure Screenshot' : '📸 Final State';
    html += `
    <div class="screenshot">
      <div class="screenshot-label ${labelClass}">${labelText}</div>
      <a href="${relativePath}" target="_blank">
        <img src="${relativePath}" alt="Screenshot for ${stepName}" />
      </a>
    </div>`;
  }
  
  html += `
  </div>`;
  
  return html;
}

// Function to create index report
function createIndexReport(runDir, testReports, command = '') {
  const indexPath = path.join(runDir, 'index.html');
  const timestamp = path.basename(runDir).split('_')[0] + '_' + path.basename(runDir).split('_')[1];
  const executionTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';
  
  // Count passed and failed tests
  const passedTests = testReports.filter(test => test.success === true).length;
  const failedTests = testReports.filter(test => test.success === false).length;
  
  // Calculate overall start time, end time, and duration
  let startTime = null;
  let endTime = null;
  
  
  // Find earliest start time and latest end time
  for (const test of testReports) {
    if (test.startTime) {
      // Parse date in format "7/3/2025, 14:45:54 IST"
      const dateTimeParts = test.startTime.replace(' IST', '').split(', ');
      if (dateTimeParts.length === 2) {
        const dateParts = dateTimeParts[0].split('/');
        const timeParts = dateTimeParts[1].split(':');
        
        if (dateParts.length === 3 && timeParts.length === 3) {
          const month = parseInt(dateParts[0]) - 1; // Month is 0-indexed
          const day = parseInt(dateParts[1]);
          const year = parseInt(dateParts[2]);
          const hours = parseInt(timeParts[0]);
          const minutes = parseInt(timeParts[1]);
          const seconds = parseInt(timeParts[2]);
          
          const testStartTime = new Date(year, month, day, hours, minutes, seconds);
          if (!startTime || testStartTime < startTime) {
            startTime = testStartTime;
          }
        }
      }
    }
    
    if (test.endTime) {
      // Parse date in format "7/3/2025, 14:47:03 IST"
      const dateTimeParts = test.endTime.replace(' IST', '').split(', ');
      if (dateTimeParts.length === 2) {
        const dateParts = dateTimeParts[0].split('/');
        const timeParts = dateTimeParts[1].split(':');
        
        if (dateParts.length === 3 && timeParts.length === 3) {
          const month = parseInt(dateParts[0]) - 1; // Month is 0-indexed
          const day = parseInt(dateParts[1]);
          const year = parseInt(dateParts[2]);
          const hours = parseInt(timeParts[0]);
          const minutes = parseInt(timeParts[1]);
          const seconds = parseInt(timeParts[2]);
          
          const testEndTime = new Date(year, month, day, hours, minutes, seconds);
          if (!endTime || testEndTime > endTime) {
            endTime = testEndTime;
          }
        }
      }
    }
  }
  
  // If we couldn't parse valid dates, use current time for the report
  if (!startTime || !endTime) {
    const now = new Date();
    if (!startTime) startTime = now;
    if (!endTime) endTime = now;
  }
  
  // Format times and calculate duration
  const formattedStartTime = startTime ? startTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'N/A';
  const formattedEndTime = endTime ? endTime.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST' : 'N/A';
  
  let durationText = 'N/A';
  if (startTime && endTime) {
    const durationSeconds = (endTime - startTime) / 1000;
    const durationMinutes = (durationSeconds / 60).toFixed(2);
    durationText = `${durationMinutes} minutes (${durationSeconds.toFixed(3)} seconds)`;
  }
  
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Execution Summary - ${timestamp}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #333; }
    .summary-container { display: flex; justify-content: space-between; flex-wrap: wrap; }
    .summary-column { background-color: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; flex: 1; margin-right: 10px; min-width: 200px; }
    .summary-column:last-child { margin-right: 0; }
    .summary-column h3 { margin-top: 0; border-bottom: 1px solid #ddd; padding-bottom: 5px; }
    .pass { color: green; }
    .fail { color: red; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
    tr:nth-child(even) { background-color: #f9f9f9; }
    tr:hover { background-color: #f5f5f5; }
  </style>
</head>
<body>
  <h1>Test Execution Summary</h1>
  <div class="summary-container">
    <div class="summary-column">
      <h3>Time Information</h3>
      <p><strong>Start Time:</strong> ${formattedStartTime}</p>
      <p><strong>End Time:</strong> ${formattedEndTime}</p>
      <p><strong>Duration:</strong> ${durationText}</p>
    </div>
    <div class="summary-column">
      <h3>Test Statistics</h3>
      <p><strong>Environment:</strong> ${env.currentEnv}</p>
      <p><strong>Total Tests:</strong> ${testReports.length}</p>
      <p><strong>Passed:</strong> <span class="pass">${passedTests}</span></p>
      <p><strong>Failed:</strong> <span class="fail">${failedTests}</span></p>
    </div>
    <div class="summary-column">
      <h3>Execution Details</h3>
      <p><strong>Command:</strong> ${command}</p>
      <p><strong>Run Directory:</strong> ${path.basename(runDir)}</p>
    </div>
  </div>
  
  <h2>Test Reports</h2>
  <table>
    <tr>
      <th>Test Name</th>
      <th>Status</th>
      <th>Start Time</th>
      <th>End Time</th>
      <th>Duration</th>
      <th>Report</th>
    </tr>`;
  
  for (const test of testReports) {
    const status = test.success === true ? 'PASS' : 'FAIL';
    const statusClass = test.success === true ? 'pass' : 'fail';
    
    // Extract just the test name without path
    let testName = '';
    if (test.testName) {
      testName = test.testName;
    } else if (test.testFile) {
      // Get just the filename without path or extension
      testName = path.basename(test.testFile, '.test');
    } else {
      testName = 'undefined';
    }
    
    // Make sure the report link points to the individual test report
    // Just use the basename since all reports are in the same directory as the index.html
    const reportFile = test.reportPath ? path.basename(test.reportPath) : '';
    
    html += `
    <tr>
      <td>${testName}</td>
      <td class="${statusClass}">${status}</td>
      <td>${test.startTime || 'N/A'}</td>
      <td>${test.endTime || 'N/A'}</td>
      <td>${test.duration || 'N/A'}</td>
      <td><a href="${reportFile}" target="_blank">View Report</a></td>
    </tr>`;
  }
  
  html += `
  </table>
</body>
</html>`;
  
  fs.writeFileSync(indexPath, html);
  console.log(`Index report created: ${indexPath}`);
  
  // Create/update link to latest run
  const latestRunLink = path.join(path.dirname(runDir), 'latest_run');
  try {
    if (fs.existsSync(latestRunLink)) {
      fs.unlinkSync(latestRunLink);
    }
    fs.symlinkSync(runDir, latestRunLink, 'junction');
    console.log(`Created symbolic link to latest run: ${latestRunLink}`);
  } catch (error) {
    console.warn(`Could not create symbolic link to latest run: ${error.message}`);
    // Copy the index file instead as a fallback
    try {
      fs.copyFileSync(
        path.join(runDir, 'index.html'),
        path.join(path.dirname(runDir), 'index.html')
      );
    } catch (copyError) {
      console.warn(`Could not copy index file: ${copyError.message}`);
    }
  }
}

module.exports = {
  getTimestamp,
  createRunDirectory,
  createHtmlReportHeader,
  createHtmlReportFooter,
  addStepToHtmlReport,
  createIndexReport
};
