/**
 * Ollama LLM Provider
 * Implements LLMProvider interface for local Ollama models
 * Uses native /api/chat endpoint for full control over options
 */

const LLMProvider = require('../llmProvider');
const { getProviderConfig } = require('../llmConfig');
const logger = require('../../../utils/logger');

class OllamaProvider extends LLMProvider {
  constructor() {
    super();
    this.config = null;
  }

  async initialize() {
    this.config = getProviderConfig();

    // Verify Ollama is reachable
    try {
      const res = await fetch(`${this.config.baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      logger.info(`Ollama connected — ${models.length} model(s) available: ${models.join(', ')}`);

      const hasModel = models.some(m => m.startsWith(this.config.model));
      if (!hasModel) {
        logger.warning(`Model "${this.config.model}" not found locally. Ollama may pull it on first request.`);
      }
    } catch (err) {
      throw new Error(`Cannot reach Ollama at ${this.config.baseURL}: ${err.message}. Is Ollama running?`);
    }
  }

  async generateCode(systemPrompt, userPrompt, conversationHistory = []) {
    const messages = [];

    // System prompt
    if (systemPrompt) {
      const systemText = typeof systemPrompt === 'string'
        ? systemPrompt
        : (systemPrompt.text || JSON.stringify(systemPrompt));
      messages.push({ role: 'system', content: systemText });
    }

    // Conversation history
    for (const msg of conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // Current user prompt
    messages.push({ role: 'user', content: userPrompt });

    // Use native /api/chat for full Ollama options support
    const url = `${this.config.baseURL}/api/chat`;
    const body = {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: this.config.temperature ?? 0,
        num_predict: this.config.maxTokens || 1024,
        num_ctx: this.config.numCtx || 8192
      },
      keep_alive: '10m'
    };

    const startTime = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeout || 180000)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama API error ${res.status}: ${errText}`);
      }

      const data = await res.json();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Ollama responded in ${elapsed}s (model: ${this.config.model})`);

      // Convert native Ollama response to OpenAI-compatible format for extractText
      return {
        choices: [{
          message: {
            role: 'assistant',
            content: data.message?.content || ''
          }
        }]
      };
    } catch (err) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.error(`Ollama API error after ${elapsed}s: ${err.message}`);
      throw err;
    }
  }

  supportsConversation() {
    return true;
  }

  supportsPromptCaching() {
    return false;
  }

  getName() {
    return 'ollama';
  }

  getModel() {
    return this.config?.model || 'unknown';
  }

  isConfigured() {
    return !!this.config?.baseURL;
  }
}

module.exports = OllamaProvider;
