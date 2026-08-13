# Writing Tests

OpenSecant tests are plain-English `.test` files. Before each run, the **step preprocessor** expands shared steps and substitutes placeholders so tests stay short, reusable, and environment-aware.

## Test file format

```text
@smoke @regression
Test: Login with valid credentials

Navigate to {{env.baseUrl}}/login
Fill username as {{env.credentials.email}}
Fill password as {{env.credentials.password}}
Click Login
Verify Welcome message is visible
```

| Line type | Purpose |
|-----------|---------|
| `@tag` | Tags for filtering (`npx opensecant --tag smoke`) |
| `Test: …` | Optional title (shown in reports) |
| Other lines | Steps executed in order (plain English) |

Steps do not need numbers. You can use `1. Click Save` if you prefer; leading numbers are stripped before execution.

---

## `@reuse` — shared step blocks

Reuse steps from another `.test` file instead of copying them.

### Syntax

```text
@reuse <filename>
```

- **`<filename>`** — Name of a `.test` file (e.g. `login.test`, `smoke/login.test`).
- The directive is **one line**; it expands to **all steps** from that file, in order.
- Expanded steps are preprocessed like normal steps (`{{env.*}}` and `{{keyword}}` apply).

### Example

**`tests/shared/login.test`**

```text
Navigate to {{env.baseUrl}}/login
Fill username as {{env.credentials.email}}
Fill password as {{env.credentials.password}}
Click Login
```

**`tests/smoke/checkout.test`**

```text
@smoke
Test: Checkout after login

@reuse login.test
Click on Cart
Click Checkout
Verify order summary is displayed
```

At run time, `checkout.test` becomes: login steps → cart → checkout → verify.

### Where files are found

The preprocessor searches (in order):

1. `tests/<filename>`
2. `tests/smoke/<filename>`
3. `tests/regression/<filename>`
4. `tests/shared/<filename>`
5. `tests/functions/<filename>`
6. Any subdirectory under `tests/` (recursive)

Use paths like `shared/login.test` when the file is in a subfolder.

### Rules and tips

- **No nested `@reuse` in the reused file** — Lines starting with `@` (tags) and `Test:` headers are skipped. Do not put `@reuse` inside a reused file; keep reused files as step lists only.
- **One `@reuse` per line** — To chain multiple files, use multiple lines:

  ```text
  @reuse common/open-app.test
  @reuse shared/login.test
  ```

- **Failure** — If the file is missing or empty, the run fails with a clear preprocess error.
- **Step store** — Cached Playwright code is keyed by the **resolved** step text after expansion and substitution, not by `@reuse` itself.

### Reporting

Logs and HTML reports show reused steps with source `reuse:<filename>`. When a value was substituted, both original and resolved text appear in the report.

---

## Environment placeholders — `{{env.*}}`

Inject values from `src/config/envConfig.js` for the active environment (`--env=develop`, `release`, etc.).

### Syntax

```text
{{env.<property>}}
{{env.<nested.property>}}
```

### Examples

| Placeholder | Typical use |
|-------------|-------------|
| `{{env.baseUrl}}` | Application URL |
| `{{env.credentials.email}}` | Login email |
| `{{env.credentials.password}}` | Login password |
| `{{env.customerFirstName}}` | Form data |
| `{{env.customerEmail}}` | Form data |
| `{{env.company}}` | Business context fields |

Define custom fields in `envConfig.js` under each environment (`develop`, `release`, …) and reference them the same way.

### Overrides

Set environment variables before running (see `.env.example`):

- `OPENSECANT_BASE_URL` → overrides `baseUrl`
- `OPENSECANT_EMAIL` / `OPENSECANT_PASSWORD` → override credentials

### Unknown properties

If `{{env.unknownField}}` is not defined, the placeholder is left unchanged and a warning is logged.

---

## Utility keywords — dynamic `{{keyword}}`

Generate fresh data on each run without hardcoding.

### Built-in keywords

| Keyword | Output | Example use |
|---------|--------|-------------|
| `{{unique}}` | Unique alphabetic string from IST timestamp (via `generateUniqueAlphabeticString`) | Last name, reference IDs |
| `{{timestamp}}` | Unix time in milliseconds | Time-based inputs |
| `{{date}}` | `YYYY-MM-DD` (today) | Date fields |
| `{{datetime}}` | ISO 8601 datetime | Audit timestamps |
| `{{random_number}}` | Random 6-digit number | Numeric codes |
| `{{random_N}}` | Random **N**-digit number (`N` = 1–15) | e.g. `{{random_4}}` → `4821` |
| `{{random_phone}}` | US-style phone `(555) 123-4567` | Phone fields |
| `{{random_email}}` | Random `xxxxxxxx@example.com` | Email fields |
| `{{random_name}}` | Random first name from a fixed pool | Name fields |
| `{{uuid}}` | UUID v4 string | Unique identifiers |

### Examples

```text
Fill last name as {{unique}}
Fill phone as {{random_phone}}
Fill email as {{random_email}}
Fill reference as {{uuid}}
Fill zip code as {{random_5}}
```

Each keyword is evaluated **once per step line** when the test runs. Two steps with `{{unique}}` get different values.

### Combining env and keywords

```text
Navigate to {{env.baseUrl}}/register
Fill first name as {{env.customerFirstName}}
Fill last name as {{unique}}
Fill email as {{random_email}}
```

---

## Preprocessing order

For every test run:

1. **Expand `@reuse`** — Inline steps from referenced files.
2. **Substitute `{{env.*}}`** — Replace with config for the active environment.
3. **Substitute `{{keyword}}`** — Generate dynamic values.

Then each resolved step is executed: StepStore → locator engine → LLM healing (if enabled).

```
.test file
    → @reuse expansion
    → {{env.*}} substitution
    → {{keyword}} substitution
    → step execution
```

---

## Interactive pause — `PAUSE`

Add a step that is **exactly** `PAUSE` (case-insensitive; optional leading number such as `12. PAUSE`) to halt the run so you can inspect the application, adjust data or UI, then continue manually.

### Example

```text
@smoke
open www.google.com
Enter "Lenovo LOQ" in to search box
Click on Google search
Click on View All
PAUSE
Click on 2nd link with text "Ideapad Slim"
```

### What happens at runtime

| Phase | Behavior |
|-------|----------|
| Before `PAUSE` | Prior steps run normally (step store, action library, or LLM). |
| At `PAUSE` | Console shows a **TEST PAUSED** banner; the browser stays on the current page. |
| Resume | Press **Enter** in the **same terminal** that launched the test. |
| After resume | Remaining steps execute as usual. |

`PAUSE` does not generate Playwright code and is not stored in `data/stepstore.json`.

### Running tests that use `PAUSE`

Use a **single test** and a **real terminal** (PowerShell, CMD, or the IDE integrated terminal):

```bash
npx opensecant search
# or
npm run test:one -- search
```

Do **not** rely on `npm run smoke` if you only want one file — that runs every smoke test.

### Requirements and limitations

| Topic | Detail |
|-------|--------|
| **vs timed wait** | `Pause for 5 seconds` is a timed wait ([Action library](ACTION_LIBRARY.md)). Bare `PAUSE` waits for you. |
| **Parallel runs** | `PAUSE` does not work in worker threads. Run sequentially (`OPENSECANT_NUM_WORKERS=1` and avoid `--parallel` with multiple tests). |
| **Non-interactive stdin** | If stdin is not a TTY, the step fails with a clear error. |
| **CI / automation** | Set `OPENSECANT_SKIP_INTERACTIVE_PAUSE=true` in `.env` to skip `PAUSE` with a warning (step still passes). **Leave this unset or commented out for local debugging.** |

### Environment variable

In `.env`:

```env
# Uncomment only for CI — skips PAUSE instead of waiting for Enter
# OPENSECANT_SKIP_INTERACTIVE_PAUSE=true
```

### HTML reports

Paused steps are recorded as **PASS** with the message: `Paused for manual inspection; continued after Enter`. If skip-env is set, the report notes that the pause was skipped.

---

## Recorder (browser overlay UI)

Capture clicks, fills, selects, and navigations while you use a headed browser. A floating **OpenSecant Recorder** panel (bottom-right) shows steps live.

### Start a session

```bash
npx opensecant record https://www.google.com --name smoke/my-flow
```

| Flag | Meaning |
|------|---------|
| `--name <name>` | Test file base name. Use `smoke/foo` to write under `tests/smoke/foo.test` |
| `--out <dir>` | Output folder under `tests/` (default: `tests/recorded`) |

### Overlay controls

| Control | Action |
|---------|--------|
| **Start** | Begin capturing (idle until you click this — avoids site auto-clicks on load) |
| **Pause / Resume** | Temporarily ignore page interactions |
| **Undo** | Drop the last captured step |
| **Stop & Save** | Write `.test`, update stepstore, save session JSON |

Synthetic / scripted clicks (`isTrusted === false`, e.g. FAQ auto-expand) are never recorded.

You can also press **Ctrl+C** in the terminal to save and exit.

### Output

1. **`.test` file** — Action-Library-style English steps (`open …`, `Click on …`, `Fill … as …`)
2. **`data/stepstore.json`** — NL → Playwright code for fast replay
3. **`reports/recorder/*-session.json`** — full event + object info (attributes, position, values)

Replay with:

```bash
npx opensecant smoke/my-flow
```

Repeated intentional actions on the same control are written **once per occurrence** in the `.test` file. Progressive typing is collapsed to a **single final Fill** per field; focus-clicks on inputs and click+check pairs are dropped. The stepstore still stores a single NL → Playwright mapping.

### Object info captured per action

Tag, role, text, label, `aria-label`, `data-testid`, `href`, name/id, value (for fills), keyboard keys (Enter), and bounding box — enough to rebuild locators without an LLM.

**Keyboard:** Pressing **Enter** (including Numpad Enter) is recorded as `Press Enter` or `Press Enter in <field>` after any pending fill is flushed.

---

## Runtime utilities (Playwright execution)

When OpenSecant runs or generates Playwright code, these are available in the execution scope:

| Name | Description |
|------|-------------|
| `page` | Playwright `Page` |
| `env` | Active environment object (same as `envConfig`) |
| `expect` | Playwright `expect` assertions |
| `generateUniqueAlphabeticString()` | Same generator as `{{unique}}` |

In `.test` files, prefer `{{unique}}` and other `{{keyword}}` placeholders. The function is mainly for generated/healed code.

---

## Full example

**`tests/smoke/nested-flow.test`**

```text
@smoke

@reuse shared/login.test
Navigate to {{env.baseUrl}}/dashboard
Fill notes as Order {{unique}}
Verify dashboard is displayed
```

**`tests/shared/login.test`**

```text
Navigate to {{env.baseUrl}}/login
Fill username as {{env.credentials.email}}
Fill password as {{env.credentials.password}}
Click Login
```

Run:

```bash
npx opensecant --env=develop --tag smoke
```

---

## Related docs

- [Architecture](ARCHITECTURE.md) — execution pipeline
- [Action library](ACTION_LIBRARY.md) — supported step phrasing
- [Environment config](../src/config/envConfig.example.js) — sample `envConfig` fields
