/**
 * Compact one-line summaries for Playwright / expect errors (no page dumps).
 */
function summarizeExecError(err) {
  const msg = err?.message || String(err);

  if (/unusual traffic|captcha|not a robot|google\.com\/sorry/i.test(msg)) {
    return 'page blocked (CAPTCHA / bot detection)';
  }

  if (/element\(s\) not found/i.test(msg)) {
    const loc = msg.match(/Locator:\s*(.+)/)?.[1]?.trim();
    return loc ? `element not found (${loc})` : 'element not found';
  }

  if (/toContainText|toHaveText|toBeVisible|Expect\s+"/i.test(msg)) {
    if (/Received string|Expected substring|unexpected value/i.test(msg)) {
      return 'assertion failed — expected content not on page';
    }
    const m = msg.match(/^(expect\([^)]+\)\.\w+\([^)]*\) failed)/i);
    if (m) return m[1];
    return 'assertion failed';
  }

  if (/Timeout:\s*\d+ms/i.test(msg)) {
    const head = msg.split('\n')[0].trim();
    return head.slice(0, 120);
  }

  const firstLine = msg.split('\n').find((l) => {
    const t = l.trim();
    return t && !t.startsWith('Call log') && !t.startsWith('-') && !t.startsWith('+');
  });

  return (firstLine || msg.split('\n')[0] || msg).trim().slice(0, 160);
}

module.exports = {
  summarizeExecError,
};
