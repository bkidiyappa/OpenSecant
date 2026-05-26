/**
 * LLM provider factory — creates Bedrock, OpenAI, Ollama, and Azure instances.
 */

const { config, validateConfig } = require('./llmConfig');
const logger = require('../../utils/logger');

// Provider class imports
const BedrockProvider = require('./providers/bedrockProvider');
const OpenAIProvider = require('./providers/openaiProvider');
const OllamaProvider = require('./providers/ollamaProvider');
const AzureOpenAIProvider = require('./providers/azureOpenAIProvider');

// Cache for singleton provider instance
let providerInstance = null;

/**
 * Create an LLM provider instance based on configuration
 * @param {string} providerName - Optional provider name override
 * @returns {Promise<LLMProvider>}
 */
async function createProvider(providerName = null) {
  const provider = providerName || config.provider;
  
  // Validate configuration
  const validation = validateConfig();
  if (!validation.valid) {
    logger.error(`LLM provider configuration invalid: ${validation.errors.join(', ')}`);
    throw new Error(`Invalid LLM configuration: ${validation.errors.join(', ')}`);
  }

  let providerInstance;

  switch (provider) {
    case 'bedrock':
      providerInstance = new BedrockProvider();
      break;

    case 'openai':
      providerInstance = new OpenAIProvider();
      break;

    case 'anthropic':
      // TODO: Implement AnthropicProvider
      throw new Error('Anthropic provider not yet implemented');

    case 'azure':
      providerInstance = new AzureOpenAIProvider();
      break;

    case 'ollama':
      providerInstance = new OllamaProvider();
      break;

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }

  // Initialize the provider
  await providerInstance.initialize();
  logger.info(`LLM provider initialized: ${providerInstance.getName()} (model: ${providerInstance.getModel()})`);

  return providerInstance;
}

/**
 * Get or create singleton provider instance
 * @returns {Promise<LLMProvider>}
 */
async function getProvider() {
  if (!providerInstance) {
    providerInstance = await createProvider();
  }
  return providerInstance;
}

/**
 * Reset provider instance (useful for testing or switching providers)
 */
function resetProvider() {
  providerInstance = null;
  logger.info('LLM provider instance reset');
}

module.exports = {
  createProvider,
  getProvider,
  resetProvider
};
