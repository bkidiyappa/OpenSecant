/**
 * Element relevance scoring for locator resolution.
 */
const {
  extractWords,
  scoreElementRelevance,
  rankElementsForTarget,
  biOverlap,
} = require('./localEngine');

module.exports = {
  extractWords,
  scoreElementRelevance,
  rankElementsForTarget,
  biOverlap,
};
