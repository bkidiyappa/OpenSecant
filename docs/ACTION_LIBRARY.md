# Action Library - Deterministic Playwright Code Generation

## Overview

The Action Library is a **deterministic pattern-matching system** that generates Playwright code without using LLM, significantly reducing API calls and improving performance.

**v3** delegates locator resolution to `localEngine.js`, which ranks DOM + accessibility snapshot data using [Playwright's recommended locator priority](https://playwright.dev/docs/locators):

1. `getByRole(role, { name })` — accessibility tree (preferred)
2. `getByTestId()` — stable test hooks
3. `getByLabel()` / `getByPlaceholder()` — form associations
4. `getByText()` / `getByAltText()` / `getByTitle()` — visible copy
5. `[name]` / `#id` — last resort (dynamic IDs deprioritized)

## How It Works

```
┌─────────────────────────────────────────────────────────┐
│  Test Step: "Fill Email as test@example.com"           │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│  STEP 1: Try Action Library (Fast, Deterministic)      │
│  ✓ Pattern match: "fill (.+) as (.+)"                  │
│  ✓ Find elements: input[data-testid="email-input"]     │
│  ✓ Generate code: page.getByTestId('email-input')...   │
│  ✓ Execute and verify                                  │
└─────────────────────────────────────────────────────────┘
                         │
                    ✓ Success? → Done (No LLM needed!)
                         │
                    ✗ Failed?
                         ▼
┌─────────────────────────────────────────────────────────┐
│  STEP 2: Fall back to LLM (Slower, More Flexible)      │
│  • Capture page context                                │
│  • Send to AWS Bedrock                                 │
│  • Try AI-generated suggestions                        │
└─────────────────────────────────────────────────────────┘
```

## Supported Action Types

### 1. Navigation
**Patterns:**
- `Navigate to <url>`
- `Go to <url>`
- `Open <url>`
- `Visit <url>`

**Generated Code:**
```javascript
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
```

### 2. Ordinal link click
**Patterns:**
- `Click on <N>nd link with text "<text>"` (e.g. `Click on 2nd link with text "Ideapad Slim"`)

**How it works:**
1. Finds `<a>` / `role=link` elements whose text contains the quoted string (case-insensitive).
2. Sorts matches by page position (top-to-left).
3. Clicks the **Nth** match using that element's **specific** locator (`href`, `data-testid`, `id`, or exact role+name).

**Fallback (always tried):** scoped positional locators for the Nth match (buttons first — Google Shopping uses `role="button"` overlays):

```javascript
await page.getByRole('button', { name: /Ideapad\s+Slim/i }).nth(1).click(); // 2nd match
await page.getByRole('link').filter({ hasText: /Ideapad\s+Slim/i }).nth(1).click();
```

**Step store:** Cached code is valid if it uses `.nth(ordinal−1)` or element-specific `href` / `data-testid`.

### 3. Click Actions
**Patterns:**
- `Click on <element>`
- `Press <button>`
- `Tap <link>`
- `Select <button> button`

**Element Priority (v3):**
1. Role + accessible name from a11y snapshot
2. `data-testid` / `data-test` / `data-qa`
3. Label / placeholder
4. Visible text
5. Name attribute / stable id

**Generated Code:**
```javascript
// Best: role + accessible name
await page.getByRole('button', { name: 'Submit', exact: false }).first().click();

// Good: test id
await page.getByTestId('submit-btn').first().click();

// Fallback: text
await page.getByText('Submit', { exact: false }).first().click();
```

### 4. Fill/Type Actions
**Patterns:**
- `Fill <field> as <value>`
- `Enter <value> in <field>`
- `Type <value> into <field>`
- `Set <field> to <value>`

**Element Priority:**
1. `data-testid` on input or parent (score: 10)
2. `name` attribute (score: 9)
3. `id` attribute (score: 9)
4. Label association (score: 8)
5. Placeholder text (score: 7)

**Generated Code:**
```javascript
// Best: data-testid
await page.getByTestId('email-input').fill('test@example.com');

// Good: name attribute
await page.locator('[name="email"]').fill('test@example.com');

// Good: label
await page.getByLabel('Email Address', { exact: false }).fill('test@example.com');
```

### 4. Select Dropdown
**Patterns:**
- `Select <value> from <field>`
- `Select <value> as <field>`
- `Choose <value> from <dropdown>`
- `Pick <value> in <field>`

**Generated Code:**
```javascript
await page.getByTestId('country-select').selectOption('USA');
await page.locator('#country').selectOption('USA');
```

### 5. Keyboard press
**Patterns:**
- `Press Enter`
- `Press Enter in <field>`
- `Hit Escape` / `Press Tab` / `Press Space` / `Press Backspace`

**Generated Code:**
```javascript
await page.keyboard.press('Enter');
await page.getByPlaceholder('Search', { exact: false }).first().press('Enter');
```

### 6. Wait Actions
**Patterns:**
- `Wait for page to load`
- `Wait for loading`
- `Wait`

**Generated Code:**
```javascript
// Prioritizes visible data-testid elements
await page.waitForSelector('[data-testid="content"]', { state: 'visible' });

// Fallback: load states
await page.waitForLoadState('domcontentloaded');
await page.waitForLoadState('networkidle');
```

### 6. Interactive pause (manual)
**Pattern:**
- `PAUSE` — exact word only (case-insensitive; not `Pause for 5 seconds`)

**Behavior:**
- Implemented in `src/utils/interactivePause.js` (not the action library / LLM).
- Stops the test until the operator presses **Enter** in the terminal; browser stays open.
- Skipped when `OPENSECANT_SKIP_INTERACTIVE_PAUSE=true`; fails in parallel workers or non-TTY stdin.

Full guide: [Writing tests — Interactive pause](WRITING_TESTS.md#interactive-pause--pause).

### 7. Hard Wait
**Patterns:**
- `Wait for <N> seconds`
- `Pause for <N> seconds`
- `Delay <N> seconds`

**Generated Code:**
```javascript
await page.waitForTimeout(5000);
```

*Fast-path: skips element capture entirely (no DOM data needed).*

### 8. Check/Uncheck
**Patterns:**
- `Check <checkbox>`
- `Tick <checkbox>`
- `Uncheck <checkbox>`
- `Untick <checkbox>`

**Generated Code:**
```javascript
await page.getByLabel('service reminder', { exact: false }).first().check();
await page.getByTestId('terms-checkbox').uncheck();
```

### 9. Validation/Assertion
**Patterns:**
- `Validate <element> is displayed`
- `Verify <element> is visible`
- `Check <element> is shown`
- `<element> should be visible`

**Generated Code:**
```javascript
await expect(page.getByTestId('success-message')).toBeVisible();
await expect(page.getByText('Thank you', { exact: false })).toBeVisible();
```

## Performance Benefits

### Before (LLM Only)
```
Step: "Fill Email as test@example.com"
├─ Capture page elements: ~500ms
├─ Send to Bedrock API: ~3000ms
├─ Parse response: ~100ms
└─ Total: ~3600ms + API cost
```

### After (Action Library First)
```
Step: "Fill Email as test@example.com"
├─ Pattern match: ~1ms
├─ Find elements: ~50ms
├─ Generate code: ~1ms
├─ Execute: ~100ms
└─ Total: ~152ms (24x faster, $0 API cost)
```

## Code Generation Strategy

### Scoring System
Each candidate is scored based on reliability:
- **Score 10**: `data-testid` attributes (most reliable)
- **Score 9**: `id` or `name` attributes
- **Score 8**: Role + accessible name
- **Score 7**: Placeholder or label text
- **Score 5**: Text content matching

Multiple candidates are generated and tried in order of confidence.

### Example: Fill Action
```javascript
// Input step: "Fill First name as John"
// Page elements: 
//   - <input data-testid="first-name" />
//   - <input name="firstName" />
//   - <input placeholder="First Name" />

// Generated candidates (sorted by score):
[
  "await page.getByTestId('first-name').fill('John');",        // Score: 10
  "await page.locator('[name=\"firstName\"]').fill('John');",  // Score: 9
  "await page.locator('[placeholder*=\"First\"]').fill('John');" // Score: 7
]

// Tries each until one succeeds
```

## Integration Points

### 1. New Step Generation
When a step has no existing selector:
```javascript
// stepExecutor.js
if (!stepConfig) {
  // Try action library first, fall back to LLM
  const healResult = await healWithBedrock(page, step, null, null, runDir);
  // healResult.source = 'library' or 'llm'
}
```

### 2. Healing Failed Steps
When existing code fails:
```javascript
// stepExecutor.js
try {
  await execCode(page, code);
} catch (error) {
  // Try action library first, fall back to LLM
  const healResult = await healWithBedrock(page, step, code, error.message, runDir);
  // healResult.source = 'library' or 'llm'
}
```

## Logging

The system logs which method generated the code:

```
[INFO] Attempting action library (deterministic) before LLM
[INFO] Detected action type: fill
[INFO] Action library generated 3 candidate(s)
[INFO] Trying action library candidate 1/3
[SUCCESS] Action library candidate 1 worked! (No LLM needed)
[INFO] Code generated via LIBRARY
```

Or if action library fails:
```
[INFO] No action library pattern match, using LLM
[INFO] Code generated via LLM
```

## Extending the Library

### Adding New Action Types

Edit `src/engines/locator/locatorResolver.js`:

```javascript
const ACTION_LIBRARY = {
  // ... existing actions ...
  
  // New action type
  hover: {
    patterns: [
      /^hover (?:over |on )?(.+)$/i,
      /^mouse over (.+)$/i
    ],
    elementTypes: ['button', 'link', 'div'],
    generateCode: (match, elements, stepText) => {
      const target = match[1].trim();
      const candidates = [];
      
      // Try data-testid
      const testIdElements = elements.filter(el => 
        el.attributes?.['data-testid']
      );
      
      for (const el of testIdElements) {
        const testId = el.attributes['data-testid'];
        if (testId.toLowerCase().includes(target.toLowerCase())) {
          candidates.push({ 
            code: `await page.getByTestId('${testId}').hover();`,
            score: 10
          });
        }
      }
      
      return candidates.sort((a, b) => b.score - a.score).map(c => c.code);
    }
  }
};
```

## Statistics Tracking

Track action library vs LLM usage in test results:

```javascript
// After test execution
const stats = {
  totalSteps: 18,
  libraryGenerated: 14,  // 78% success rate
  llmGenerated: 4,       // 22% needed LLM
  apiCostSaved: '$0.042' // Estimated based on Bedrock pricing
};
```

## Best Practices

### 1. Use Semantic Test Steps
✅ Good: `Fill Email as test@example.com`
❌ Bad: `Type test@example.com into the email field on the form`

### 2. Use data-testid Attributes
```html
<!-- Best for action library -->
<input data-testid="email-input" type="email" />

<!-- Still works but lower priority -->
<input name="email" type="email" />
```

### 3. Consistent Naming
- Use consistent step patterns across tests
- Action library learns from patterns
- More matches = fewer LLM calls

## Troubleshooting

### Action Library Not Matching
**Symptom:** All steps use LLM
**Solution:** Check step patterns match library regex

### Wrong Element Selected
**Symptom:** Action library generates code but selects wrong element
**Solution:** Add more specific `data-testid` attributes

### Performance Not Improved
**Symptom:** Still slow despite action library
**Solution:** Check logs - may be falling back to LLM due to pattern mismatches

## Future Enhancements

1. **Learning Mode**: Analyze successful LLM-generated code to auto-add patterns
2. **Custom Patterns**: Project-specific pattern files
3. **Statistics Dashboard**: Track library vs LLM usage over time
