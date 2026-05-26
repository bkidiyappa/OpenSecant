/**
 * In-memory conversation state for LLM healing sessions.
 */
const ConversationManager = require('../providers/llm/conversationManager');

let sessionManager = null;

function getMemoryStore() {
  if (!sessionManager) {
    sessionManager = new ConversationManager();
  }
  return sessionManager;
}

function resetMemoryStore() {
  sessionManager = null;
}

module.exports = {
  getMemoryStore,
  resetMemoryStore,
  ConversationManager,
};
