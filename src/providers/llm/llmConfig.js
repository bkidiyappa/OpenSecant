/**
 * LLM Configuration Module
 * Centralized configuration for all LLM providers
 */

const config = {
  // Active provider (can be overridden by LLM_PROVIDER env variable)
  provider: process.env.LLM_PROVIDER || 'ollama',
  //provider: process.env.LLM_PROVIDER || 'bedrock',
  //provider: process.env.LLM_PROVIDER || 'openai',
  
  // AWS Bedrock configuration
  bedrock: {
    region: process.env.AWS_DEFAULT_REGION || 'us-east-2',
    modelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
    anthropicVersion: 'bedrock-2023-05-31',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN
    }
  },

  // OpenAI configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    baseURL: process.env.OPENAI_BASE_URL, // For Azure OpenAI or custom endpoints
    organization: process.env.OPENAI_ORG_ID
  },

  // Anthropic Direct API configuration
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    version: '2023-06-01'
  },

  // Azure OpenAI configuration
  azure: {
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'
  },

  // Ollama (local LLM) configuration
  ollama: {
    baseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'gemma4:e2b',
    numCtx: parseInt(process.env.OLLAMA_NUM_CTX) || 16384
  },

  // Common settings
  common: {
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS) || 20000,
    temperature: parseFloat(process.env.LLM_TEMPERATURE) || 0,
    timeout: parseInt(process.env.LLM_TIMEOUT) || 180000 // 180 seconds
  }
};

/**
 * Get configuration for the active provider
 * @returns {Object}
 */
function getProviderConfig() {
  const provider = config.provider;
  if (!config[provider]) {
    throw new Error(`Unknown LLM provider: ${provider}`);
  }
  return {
    ...config[provider],
    ...config.common
  };
}

/**
 * Validate that the active provider is properly configured
 * @returns {Object} { valid: boolean, errors: string[] }
 */
function validateConfig() {
  const provider = config.provider;
  const errors = [];

  switch (provider) {
    case 'bedrock':
      if (!config.bedrock.credentials.accessKeyId) {
        errors.push('AWS_ACCESS_KEY_ID is not set');
      }
      if (!config.bedrock.credentials.secretAccessKey) {
        errors.push('AWS_SECRET_ACCESS_KEY is not set');
      }
      break;

    case 'openai':
      if (!config.openai.apiKey) {
        errors.push('OPENAI_API_KEY is not set');
      }
      break;

    case 'anthropic':
      if (!config.anthropic.apiKey) {
        errors.push('ANTHROPIC_API_KEY is not set');
      }
      break;

    case 'azure':
      if (!config.azure.apiKey) {
        errors.push('AZURE_OPENAI_API_KEY is not set');
      }
      if (!config.azure.endpoint) {
        errors.push('AZURE_OPENAI_ENDPOINT is not set');
      }
      if (!config.azure.deploymentName) {
        errors.push('AZURE_OPENAI_DEPLOYMENT is not set');
      }
      break;

    case 'ollama':
      // Ollama doesn't require credentials, just check if URL is set
      break;

    default:
      errors.push(`Unknown provider: ${provider}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  config,
  getProviderConfig,
  validateConfig
};
