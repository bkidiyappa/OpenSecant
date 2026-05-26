/**
 * Conversation Manager
 * Manages conversation state and history for LLM providers
 */

const logger = require('../../utils/logger');

class ConversationManager {
  constructor(provider) {
    this.provider = provider;
    this.messages = [];
    this.systemPrompt = null;
    this.initialized = false;
  }

  /**
   * Initialize conversation with system prompt
   * @param {string|Object} systemPrompt - System prompt text or structured prompt
   */
  initialize(systemPrompt) {
    if (this.initialized) {
      logger.info('Conversation session already initialized');
      return;
    }

    this.systemPrompt = systemPrompt;
    this.initialized = true;
    logger.info('Conversation session initialized with static system prompt');
  }

  /**
   * Add a message to conversation history
   * @param {string} role - Message role ('user' or 'assistant')
   * @param {string} content - Message content
   */
  addMessage(role, content) {
    if (!this.provider.supportsConversation()) {
      // Provider doesn't support conversation, don't store history
      return;
    }

    this.messages.push({
      role,
      content
    });
  }

  /**
   * Get conversation history
   * @returns {Array}
   */
  getHistory() {
    return this.messages;
  }

  /**
   * Get system prompt
   * @returns {string|Object}
   */
  getSystemPrompt() {
    return this.systemPrompt;
  }

  /**
   * Reset conversation history
   */
  reset() {
    this.messages = [];
    logger.info('Conversation history reset');
  }

  /**
   * Clear all state (history and system prompt)
   */
  clear() {
    this.messages = [];
    this.systemPrompt = null;
    this.initialized = false;
    logger.info('Conversation session cleared');
  }

  /**
   * Get conversation statistics
   * @returns {Object}
   */
  getStats() {
    return {
      messageCount: this.messages.length,
      userMessages: this.messages.filter(m => m.role === 'user').length,
      assistantMessages: this.messages.filter(m => m.role === 'assistant').length,
      initialized: this.initialized
    };
  }
}

module.exports = ConversationManager;
