/**
 * Base LLM Provider Interface
 * All LLM providers must implement this interface
 */
class LLMProvider {
  /**
   * Initialize the LLM provider (setup client, validate credentials, etc.)
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented by provider');
  }

  /**
   * Generate code suggestions from the LLM
   * @param {string} systemPrompt - The system prompt defining the LLM's role
   * @param {string} userPrompt - The user's request/question
   * @param {Array} conversationHistory - Previous messages in the conversation
   * @returns {Promise<Object>} - Raw response from the LLM
   */
  async generateCode(systemPrompt, userPrompt, conversationHistory = []) {
    throw new Error('generateCode() must be implemented by provider');
  }

  /**
   * Check if this provider supports conversation history
   * @returns {boolean}
   */
  supportsConversation() {
    return false;
  }

  /**
   * Check if this provider supports prompt caching
   * @returns {boolean}
   */
  supportsPromptCaching() {
    return false;
  }

  /**
   * Get the provider name
   * @returns {string}
   */
  getName() {
    throw new Error('getName() must be implemented by provider');
  }

  /**
   * Get the model name/ID being used
   * @returns {string}
   */
  getModel() {
    return 'unknown';
  }

  /**
   * Check if the provider is properly configured
   * @returns {boolean}
   */
  isConfigured() {
    throw new Error('isConfigured() must be implemented by provider');
  }
}

module.exports = LLMProvider;
