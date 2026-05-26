/**
 * Environment configuration for test data.
 *
 * Copy and customize for your application. Override via environment variables:
 *   OPENSECANT_BASE_URL, OPENSECANT_EMAIL, OPENSECANT_PASSWORD
 */
const { generateUniqueAlphabeticString } = require('../utils/uniqueStringGenerator');

const environments = {
  develop: {
    baseUrl: process.env.OPENSECANT_BASE_URL || 'https://the-internet.herokuapp.com',
    credentials: {
      email: process.env.OPENSECANT_EMAIL || 'tomsmith',
      password: process.env.OPENSECANT_PASSWORD || 'SuperSecretPassword!',
    },
    customerFirstName: 'Test',
    customerLastName: generateUniqueAlphabeticString(),
    customerPhone: '(555) 555-0100',
    customerPhoneType: 'Mobile',
    customerEmail: 'demo.user@example.com',
    customerEmailType: 'Personal',
    customerZipCode: '10001'
  },

  release: {
    baseUrl: process.env.OPENSECANT_BASE_URL || 'https://staging.example.com',
    credentials: {
      email: process.env.OPENSECANT_EMAIL || 'test.user@example.com',
      password: process.env.OPENSECANT_PASSWORD || 'changeme',
    },
    company: 'Acme Demo Co',
    businessUnit: 'Demo Unit 001',
    customerFirstName: 'Test',
    customerLastName: generateUniqueAlphabeticString(),
    customerPhone: '(555) 555-0100',
    customerPhoneType: 'Mobile',
    customerEmail: 'demo.user@example.com',
    customerEmailType: 'Personal',
    customerZipCode: '10001',
  },

  preprod: {
    baseUrl: process.env.OPENSECANT_BASE_URL || 'https://preprod.example.com',
    credentials: {
      email: process.env.OPENSECANT_EMAIL || 'test.user@example.com',
      password: process.env.OPENSECANT_PASSWORD || 'changeme',
    },
    company: 'Acme Demo Co',
    businessUnit: 'Demo Unit 001',
    customerFirstName: 'Test',
    customerLastName: generateUniqueAlphabeticString(),
    customerPhone: '(555) 555-0100',
    customerPhoneType: 'Mobile',
    customerEmail: 'demo.user@example.com',
    customerEmailType: 'Personal',
    customerZipCode: '10001',
  },

  production: {
    baseUrl: process.env.OPENSECANT_BASE_URL || 'https://www.example.com',
    credentials: {
      email: process.env.OPENSECANT_EMAIL || 'test.user@example.com',
      password: process.env.OPENSECANT_PASSWORD || 'changeme',
    },
    company: 'Acme Demo Co',
    businessUnit: 'Demo Unit 001',
    customerFirstName: 'Test',
    customerLastName: generateUniqueAlphabeticString(),
    customerPhone: '(555) 555-0100',
    customerPhoneType: 'Mobile',
    customerEmail: 'demo.user@example.com',
    customerEmailType: 'Personal',
    customerZipCode: '10001',
  },
};

const testConfig = {
  numWorkers: parseInt(process.env.OPENSECANT_NUM_WORKERS || '2', 10),
  browser: process.env.OPENSECANT_BROWSER || process.env.BROWSER || 'edge',
  slowMo: 1000,
  headless: process.env.HEADLESS !== undefined
    ? process.env.HEADLESS.toLowerCase() === 'true'
    : false,
  timeout: 30000,
  aiHealingEnabled: process.env.AI_HEALING_ENABLED !== undefined
    ? process.env.AI_HEALING_ENABLED.toLowerCase() === 'true'
    : true,
  bedrockConfig: {
    modelId: process.env.BEDROCK_MODEL || 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    maxRetries: parseInt(process.env.BEDROCK_MAX_RETRIES || '3', 10),
    maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS || '8000', 10),
  },
};

const getCurrentEnvironment = () => {
  const envArg = process.argv.find((arg) => arg.startsWith('--env='));
  if (envArg) {
    const envName = envArg.split('=')[1];
    if (environments[envName]) {
      return envName;
    }
    console.warn(`Environment '${envName}' not found, available: ${Object.keys(environments).join(', ')}`);
    console.warn('Using default environment: develop');
  }
  return 'develop';
};

const currentEnv = getCurrentEnvironment();
console.log(`Using environment: ${currentEnv}`);

module.exports = {
  ...environments[currentEnv],
  testConfig,
  currentEnv,
};
