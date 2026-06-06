/**
 * Response Parser Module
 * Handles parsing and extracting text from different LLM provider responses
 */

const logger = require('../../utils/logger');

/**
 * Extract text content from Bedrock response
 * @param {Object} responseBody - Bedrock response body
 * @returns {string}
 */
function extractBedrockText(responseBody) {
  if (!responseBody) return '';
  
  // Claude 3+ format (messages API)
  if (responseBody.content && Array.isArray(responseBody.content)) {
    for (const item of responseBody.content) {
      if (item.type === 'text' && item.text) return item.text;
      if (item.text) return item.text;
    }
  }
  
  // Legacy formats
  if (responseBody.completion) return responseBody.completion;
  if (responseBody.text) return responseBody.text;
  if (responseBody.generated_text) return responseBody.generated_text;
  if (typeof responseBody.content === 'string') return responseBody.content;
  
  return JSON.stringify(responseBody);
}

/**
 * Extract text content from OpenAI response
 * @param {Object} response - OpenAI response object
 * @returns {string}
 */
function extractOpenAIText(response) {
  if (!response) return '';
  
  // Chat completion format
  if (response.choices && response.choices.length > 0) {
    const choice = response.choices[0];
    if (choice.message && choice.message.content) {
      return choice.message.content;
    }
    if (choice.text) {
      return choice.text;
    }
  }
  
  return JSON.stringify(response);
}

/**
 * Extract text content from Anthropic response
 * @param {Object} response - Anthropic API response
 * @returns {string}
 */
function extractAnthropicText(response) {
  if (!response) return '';
  
  // Messages API format
  if (response.content && Array.isArray(response.content)) {
    for (const item of response.content) {
      if (item.type === 'text' && item.text) return item.text;
    }
  }
  
  return JSON.stringify(response);
}

/**
 * Extract text content from Ollama response
 * @param {Object} response - Ollama response object
 * @returns {string}
 */
function extractOllamaText(response) {
  if (!response) return '';
  
  if (response.message && response.message.content) {
    return response.message.content;
  }
  
  if (response.response) {
    return response.response;
  }
  
  return JSON.stringify(response);
}

/**
 * Extract text from any provider response
 * @param {Object} response - Raw response from LLM provider
 * @param {string} provider - Provider name ('bedrock', 'openai', 'anthropic', 'ollama')
 * @returns {string}
 */
function extractText(response, provider) {
  switch (provider) {
    case 'bedrock':
      return extractBedrockText(response);
    case 'openai':
    case 'azure':
      return extractOpenAIText(response);
    case 'anthropic':
      return extractAnthropicText(response);
    case 'ollama':
      return extractOpenAIText(response) || extractOllamaText(response);
    default:
      logger.warning(`Unknown provider: ${provider}, attempting generic extraction`);
      return JSON.stringify(response);
  }
}

/**
 * Detect truncated or malformed Playwright snippets before execution.
 * @param {string} code
 * @returns {boolean}
 */
function isValidPlaywrightCode(code) {
  if (!code || typeof code !== 'string') return false;

  const s = code.trim();
  if (!/^await\s+page\./.test(s)) return false;
  if (!s.endsWith(';')) return false;

  // Truncated selectors / attributes (common with small LLMs + broken JSON)
  if (/=\s*;/.test(s)) return false;
  if (/\[[\w-]+=\s*;/.test(s)) return false;
  if (/\.(click|fill|press|type|check|selectOption)\(\s*['"`][^'"`]*$/.test(s)) return false;

  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
    }
  }
  if (depth !== 0) return false;

  for (const q of ['"', "'", '`']) {
    let n = 0;
    let escaped = false;
    for (const ch of s) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === q) n++;
    }
    if (n % 2 !== 0) return false;
  }

  try {
    // eslint-disable-next-line no-new-func
    new Function('page', 'expect', `return async () => { ${s} };`);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Clean LLM-generated Playwright code (strip JSON artifacts, fix terminators).
 * @param {string} code
 * @returns {string}
 */
function sanitizePlaywrightCode(code) {
  if (!code || typeof code !== 'string') return '';

  let s = code.trim();

  // Strip wrapping quotes and trailing JSON junk (e.g. `",` or `"}`)
  s = s.replace(/^["']+/, '').replace(/["']+$/, '');
  s = s.replace(/["']\s*,?\s*$/g, '');
  s = s.replace(/\s*["'}[\],]+\s*$/g, '');

  // Extract first complete await statement if multiple fragments glued together
  const awaitMatch = s.match(/await\s+[\s\S]+?;/);
  if (awaitMatch) {
    s = awaitMatch[0];
  } else if (/^page\./.test(s)) {
    s = `await ${s}`;
  } else if (!/^await\s/.test(s) && s.includes('page.')) {
    const idx = s.indexOf('await ');
    if (idx >= 0) s = s.slice(idx);
  }

  s = s.trim();
  if (s && !s.endsWith(';')) {
    const trimmed = s.replace(/["',}\]]+\s*$/g, '');
    if (!isValidPlaywrightCode(`${trimmed};`)) {
      return '';
    }
    s = `${trimmed};`;
  }

  return isValidPlaywrightCode(s) ? s.trim() : '';
}

/**
 * Sanitize and keep only executable Playwright snippets.
 * @param {string} code
 * @returns {string}
 */
function normalizeSuggestion(code) {
  return sanitizePlaywrightCode(code);
}

/**
 * Extract code strings from malformed JSON via regex (when JSON.parse fails).
 * @param {string} text
 * @returns {string[]}
 */
function extractCodeFromBrokenJson(text) {
  const found = [];
  const patterns = [
    /"code"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /'code'\s*:\s*'((?:\\.|[^'\\])*)'/g,
    /"code"\s*:\s*`([^`]+)`/g,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      try {
        const decoded = JSON.parse(`"${m[1].replace(/"/g, '\\"')}"`);
        if (decoded) found.push(decoded);
      } catch (_) {
        found.push(m[1]);
      }
    }
  }

  return found.map(normalizeSuggestion).filter(Boolean);
}

/**
 * Keep unique, valid suggestions only.
 * @param {string[]} arr
 * @returns {string[]}
 */
function dedupeValidSuggestions(arr) {
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const code = normalizeSuggestion(typeof item === 'object' && item?.code ? item.code : item);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * Parse suggestions from LLM response text
 * Handles JSON, code blocks, and regex fallback
 * @param {string} text - Response text from LLM
 * @returns {Array<string>} - Array of code suggestions
 */
function parseSuggestions(text) {
  if (!text) return [];

  let rejectedCount = 0;
  const collect = (raw) => {
    const before = Array.isArray(raw) ? raw.length : 1;
    const valid = dedupeValidSuggestions(Array.isArray(raw) ? raw : [raw]);
    rejectedCount += Math.max(0, before - valid.length);
    return valid;
  };

  // Step 1: Extract JSON string (from code block or raw)
  let jsonString = null;
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    jsonString = codeBlockMatch[1].trim();
  } else {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonString = jsonMatch[0];
  }

  // Step 2: Try to parse JSON
  if (jsonString) {
    try {
      const cleaned = jsonString
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/[\x00-\x1f]/g, ' ');

      const parsed = JSON.parse(cleaned);

      if (parsed.suggestions && Array.isArray(parsed.suggestions)) {
        const valid = collect(parsed.suggestions);
        if (valid.length > 0) return valid;
      }
      if (Array.isArray(parsed)) {
        const valid = collect(parsed);
        if (valid.length > 0) return valid;
      }
      if (parsed.code) {
        const valid = collect([parsed.code]);
        if (valid.length > 0) return valid;
      }
    } catch (jsonErr) {
      logger.warning(`JSON parse failed: ${jsonErr.message}`);
      const fromBroken = extractCodeFromBrokenJson(jsonString) || extractCodeFromBrokenJson(text);
      if (fromBroken.length > 0) {
        const valid = dedupeValidSuggestions(fromBroken);
        if (valid.length > 0) return valid;
      }
    }
  }

  // Step 3: Regex fallback — complete await statements ending with ;
  const awaitMatches = text.match(/await\s+page\.[^;]+;/g);
  if (awaitMatches && awaitMatches.length > 0) {
    const valid = dedupeValidSuggestions(awaitMatches);
    if (valid.length > 0) return valid;
  }

  // Step 4: page.* calls without await
  const codePatterns = text.match(/page\.[a-zA-Z]+\([^)]*\)/g);
  if (codePatterns && codePatterns.length > 0) {
    const valid = dedupeValidSuggestions(
      codePatterns.map((p) => `await ${p};`),
    );
    if (valid.length > 0) return valid;
  }

  if (rejectedCount > 0) {
    logger.warning(`Rejected ${rejectedCount} malformed LLM suggestion(s) (truncated or invalid syntax)`);
  }
  logger.warning('Could not parse any valid suggestions from LLM response');
  return [];
}

module.exports = {
  extractText,
  extractBedrockText,
  extractOpenAIText,
  extractAnthropicText,
  extractOllamaText,
  isValidPlaywrightCode,
  sanitizePlaywrightCode,
  normalizeSuggestion,
  parseSuggestions,
};
