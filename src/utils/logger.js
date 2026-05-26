const colors = {
  reset: '\x1b[0m',
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m'
};

// Log levels with their colors
const logLevels = {
  INFO: colors.cyan,
  SUCCESS: colors.green,
  WARNING: colors.yellow,
  ERROR: colors.red,
  STEP: colors.brightBlue,
  FUNCTION: colors.brightMagenta,
  SYSTEM: colors.brightWhite
};

// Get current timestamp in IST timezone
function getTimestamp() {
  const now = new Date();
  // Convert to IST timezone (UTC+5:30)
  const options = { 
    timeZone: 'Asia/Kolkata', 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  };
  return now.toLocaleString('en-US', options);
}

// Main logging function
function log(message, level = 'INFO') {
  const timestamp = getTimestamp();
  const color = logLevels[level] || colors.white;
  
  originalConsoleLog(`${colors.brightYellow}[${timestamp}]${colors.reset} ${color}[${level}]${colors.reset} ${message}`);
}

// Specialized logging functions
function info(message) {
  log(message, 'INFO');
}

function success(message) {
  log(message, 'SUCCESS');
}

function warning(message) {
  const timestamp = getTimestamp();
  const color = logLevels['WARNING'];
  originalConsoleWarn(`${colors.brightYellow}[${timestamp}]${colors.reset} ${color}[WARNING]${colors.reset} ${message}`);
}

function error(message) {
  const timestamp = getTimestamp();
  const color = logLevels['ERROR'];
  originalConsoleError(`${colors.brightYellow}[${timestamp}]${colors.reset} ${color}[ERROR]${colors.reset} ${message}`);
}

function step(message) {
  log(message, 'STEP');
}

function functionLog(message) {
  log(message, 'FUNCTION');
}

function system(message) {
  log(message, 'SYSTEM');
}

// Override console.log, console.error, console.warn
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

// Function to restore original console methods
function restoreConsole() {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
}

// Function to override console methods
function overrideConsole() {
  // Store references to original methods
  const _log = console.log;
  const _error = console.error;
  const _warn = console.warn;
  
  // Override console.log
  console.log = function() {
    // Convert arguments to array
    const args = Array.from(arguments);
    if (args.length > 0) {
      // Use the original console reference to avoid recursion
      const timestamp = getTimestamp();
      const color = logLevels['INFO'];
      originalConsoleLog(`${colors.brightYellow}[${timestamp}]${colors.reset} ${color}[INFO]${colors.reset} ${args.join(' ')}`);
    }
  };
  
  // Override console.error
  console.error = function() {
    const args = Array.from(arguments);
    if (args.length > 0) {
      const timestamp = getTimestamp();
      const color = logLevels['ERROR'];
      originalConsoleError(`${colors.brightYellow}[${timestamp}]${colors.reset} ${color}[ERROR]${colors.reset} ${args.join(' ')}`);
    }
  };
  
  // Override console.warn
  console.warn = function() {
    const args = Array.from(arguments);
    if (args.length > 0) {
      const timestamp = getTimestamp();
      const color = logLevels['WARNING'];
      const workerPrefix = getWorkerPrefix();
      originalConsoleWarn(`${colors.brightYellow}[${timestamp}]${colors.reset} ${workerPrefix}${color}[WARNING]${colors.reset} ${args.join(' ')}`);
    }
  };
}

// Flag to track if console is overridden
let isConsoleOverridden = false;

/**
 * Disable console override - useful for worker threads
 */
function disableConsoleOverride() {
  if (isConsoleOverridden) {
    restoreConsole();
  }
}

/**
 * Check if running in a worker thread
 */
function isWorkerThread() {
  try {
    return require('worker_threads').isMainThread === false;
  } catch (e) {
    return false;
  }
}

// Add worker thread prefix to log messages if running in a worker
function getWorkerPrefix() {
  if (isWorkerThread()) {
    const threadId = require('worker_threads').threadId;
    return `[Worker ${threadId}] `;
  }
  return '';
}

module.exports = {
  log,
  info,
  success,
  warning,
  error,
  step,
  functionLog,
  system,
  overrideConsole,
  restoreConsole,
  disableConsoleOverride,
  isWorkerThread
};
