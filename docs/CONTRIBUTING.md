# Contributing to OpenSecant

Thank you for helping improve OpenSecant.

## Development setup

See [System requirements](SYSTEM_REQUIREMENTS.md) first. For local LLMs via Ollama, a **6+ GB GPU** is required.

```bash
npm install
npx playwright install chromium
cp src/config/envConfig.example.js src/config/envConfig.js
cp .env.example .env
```

## Running tests

```bash
npm run smoke
npm test
```

When adding or changing tests, see [Writing tests](WRITING_TESTS.md) for `@reuse` and `{{keyword}}` / `{{env.*}}` placeholders.

## Code guidelines

- Match existing module layout under `src/engines`, `src/runner`, and `src/providers`
- Keep natural-language step resolution deterministic before LLM fallback
- Do not commit secrets, `.env`, or local `data/stepstore.json` entries with sensitive URLs
- Update docs when changing CLI flags or resolution order

## Pull requests

1. Fork the repository
2. Create a feature branch
3. Include a clear description and test plan
4. Ensure smoke tests pass locally

## Reporting issues

Include:

- OpenSecant version (`package.json`)
- Node.js version
- Browser and LLM provider used
- Minimal `.test` file or agent goal to reproduce
