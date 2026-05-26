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
