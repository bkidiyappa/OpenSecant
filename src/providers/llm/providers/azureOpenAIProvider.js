/**
 * Azure OpenAI provider (uses OpenAI SDK with Azure endpoint).
 */
const LLMProvider = require('../llmProvider');
const { getProviderConfig } = require('../llmConfig');
const logger = require('../../../utils/logger');

class AzureOpenAIProvider extends LLMProvider {
  constructor() {
    super();
    this.name = 'azure-openai';
  }

  async initialize() {
    const cfg = getProviderConfig('azure');
    this.model = cfg.model || 'gpt-4o';
    this.endpoint = cfg.endpoint || process.env.AZURE_OPENAI_ENDPOINT;
    this.apiKey = cfg.apiKey || process.env.AZURE_OPENAI_API_KEY;

    if (!this.endpoint || !this.apiKey) {
      throw new Error('Azure OpenAI requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY');
    }

    const { OpenAI } = require('openai');
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: `${this.endpoint.replace(/\/$/, '')}/openai/deployments/${cfg.deployment || this.model}`,
      defaultQuery: { 'api-version': cfg.apiVersion || '2024-02-15-preview' },
      defaultHeaders: { 'api-key': this.apiKey },
    });

    logger.info(`Azure OpenAI initialized (deployment: ${cfg.deployment || this.model})`);
  }

  getName() {
    return this.name;
  }

  getModel() {
    return this.model;
  }

  async generate(prompt, options = {}) {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: options.maxTokens || 1024,
      temperature: options.temperature ?? 0.2,
    });
    return response.choices[0]?.message?.content || '';
  }
}

module.exports = AzureOpenAIProvider;
