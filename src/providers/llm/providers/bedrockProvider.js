/**
 * AWS Bedrock LLM Provider
 * Implements LLMProvider interface for AWS Bedrock
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const LLMProvider = require('../llmProvider');
const { getProviderConfig } = require('../llmConfig');
const logger = require('../../../utils/logger');

class BedrockProvider extends LLMProvider {
  constructor() {
    super();
    this.client = null;
    this.config = null;
  }

  async initialize() {
    this.config = getProviderConfig();
    
    if (!this.config.credentials.accessKeyId || !this.config.credentials.secretAccessKey) {
      throw new Error('AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.');
    }

    try {
      this.client = new BedrockRuntimeClient({
        region: this.config.region,
        credentials: {
          accessKeyId: this.config.credentials.accessKeyId,
          secretAccessKey: this.config.credentials.secretAccessKey,
          sessionToken: this.config.credentials.sessionToken
        }
      });
      logger.info('AWS Bedrock client initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize AWS Bedrock client: ${error.message}`);
      throw error;
    }
  }

  async generateCode(systemPrompt, userPrompt, conversationHistory = []) {
    if (!this.client) {
      throw new Error('Bedrock client not initialized. Call initialize() first.');
    }

    // Build messages array for Bedrock
    const messages = [];
    
    // Add conversation history
    for (const msg of conversationHistory) {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
    
    // Add current user prompt
    messages.push({
      role: 'user',
      content: userPrompt
    });

    // Build request body for Bedrock
    const requestBody = {
      anthropic_version: this.config.anthropicVersion,
      max_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      messages: messages
    };

    // Add system prompt (with caching if supported)
    if (systemPrompt) {
      if (typeof systemPrompt === 'string') {
        requestBody.system = [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' }
          }
        ];
      } else if (systemPrompt.type === 'text') {
        // Already structured with cache_control
        requestBody.system = [systemPrompt];
      } else {
        requestBody.system = systemPrompt;
      }
    }

    try {
      const command = new InvokeModelCommand({
        modelId: this.config.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody)
      });

      const response = await this.client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      
      return responseBody;
    } catch (error) {
      logger.error(`Bedrock API error: ${error.message}`);
      throw error;
    }
  }

  supportsConversation() {
    return true;
  }

  supportsPromptCaching() {
    return true;
  }

  getName() {
    return 'bedrock';
  }

  getModel() {
    return this.config?.modelId || 'unknown';
  }

  isConfigured() {
    return !!(
      this.config?.credentials?.accessKeyId &&
      this.config?.credentials?.secretAccessKey
    );
  }
}

module.exports = BedrockProvider;
