/**
 * OpenAI LLM Provider
 * Implements LLMProvider interface for OpenAI API
 */

const LLMProvider = require('../llmProvider');
const { getProviderConfig } = require('../llmConfig');
const logger = require('../../../utils/logger');

class OpenAIProvider extends LLMProvider {
  constructor() {
    super();
    this.config = null;
    this.OpenAI = null;
    this.client = null;
  }

  async initialize() {
    this.config = getProviderConfig();
    
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable.');
    }

    try {
      // Dynamically import OpenAI SDK
      const { OpenAI } = require('openai');
      this.OpenAI = OpenAI;
      
      const clientConfig = {
        apiKey: this.config.apiKey
      };
      
      if (this.config.baseURL) {
        clientConfig.baseURL = this.config.baseURL;
      }
      
      if (this.config.organization) {
        clientConfig.organization = this.config.organization;
      }
      
      this.client = new this.OpenAI(clientConfig);
      logger.info('OpenAI client initialized successfully');
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') {
        throw new Error('OpenAI SDK not installed. Run: npm install openai');
      }
      logger.error(`Failed to initialize OpenAI client: ${error.message}`);
      throw error;
    }
  }

  async generateCode(systemPrompt, userPrompt, conversationHistory = []) {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. Call initialize() first.');
    }

    // Build messages array for OpenAI
    const messages = [];
    
    // Add system prompt
    if (systemPrompt) {
      const systemText = typeof systemPrompt === 'string' 
        ? systemPrompt 
        : (systemPrompt.text || JSON.stringify(systemPrompt));
      
      messages.push({
        role: 'system',
        content: systemText
      });
    }
    
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

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: messages,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature
      });
      
      return response;
    } catch (error) {
      logger.error(`OpenAI API error: ${error.message}`);
      throw error;
    }
  }

  supportsConversation() {
    return true;
  }

  supportsPromptCaching() {
    return false;
  }

  getName() {
    return 'openai';
  }

  getModel() {
    return this.config?.model || 'unknown';
  }

  isConfigured() {
    return !!this.config?.apiKey;
  }
}

module.exports = OpenAIProvider;
