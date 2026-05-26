/**
 * Example environment configuration — copy to envConfig.js and customize.
 *
 * Environment variables (optional overrides):
 *   OPENSECANT_BASE_URL, OPENSECANT_EMAIL, OPENSECANT_PASSWORD
 *   OPENSECANT_BROWSER, HEADLESS, AI_HEALING_ENABLED, OPENSECANT_NUM_WORKERS
 */
const { generateUniqueAlphabeticString } = require('../utils/uniqueStringGenerator');

const environments = {
  develop: {
    baseUrl: 'https://the-internet.herokuapp.com',
    credentials: {
      email: 'tomsmith',
      password: 'SuperSecretPassword!',
    },
    customerFirstName: 'Test',
    customerLastName: generateUniqueAlphabeticString(),
    customerEmail: 'demo.user@example.com',
  },
  release: {
    baseUrl: 'https://staging.example.com',
    credentials: {
      email: 'test.user@example.com',
      password: 'changeme',
    },
  },
};

module.exports = { environments };
