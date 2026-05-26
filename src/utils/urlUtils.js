/**
 * Normalize URLs from plain-English test steps for page.goto().
 * @param {string} url
 * @returns {string}
 */
function normalizeNavigationUrl(url) {
  if (!url || typeof url !== 'string') return url;

  let u = url.trim().replace(/^["']|["']$/g, '');

  if (/^https?:\/\//i.test(u)) {
    return u;
  }
  if (u.startsWith('//')) {
    return `https:${u}`;
  }
  if (/^(www\.|[a-z0-9][-a-z0-9]*\.[a-z]{2,})/i.test(u)) {
    return `https://${u}`;
  }
  return u;
}

module.exports = { normalizeNavigationUrl };
