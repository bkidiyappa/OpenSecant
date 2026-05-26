# OpenSecant

Natural-language test automation with Playwright, deterministic locator intelligence, and optional LLM self-healing.

Write tests as plain English. OpenSecant resolves each step through a persistent step store, local locator engine, and LLM fallback when needed.

## Features

- **Plain-English `.test` files** — no brittle selectors in test source
- **Step store** — caches working Playwright code in `data/stepstore.json`
- **Locator engine** — role/name, label, placeholder, test id priority (Playwright best practices)
- **Self-healing** — retries with deterministic patterns, then LLM suggestions
- **QA agent** — autonomous exploration and test generation from goals
- **Multi-provider LLM** — Bedrock, OpenAI, Ollama, Azure OpenAI

## Quick start

```bash
git clone https://github.com/opensecant/opensecant.git
cd opensecant
npm install
npx playwright install chromium

# Copy and customize environment config
cp src/config/envConfig.example.js src/config/envConfig.js

# Run smoke tests
npm run smoke
```

## Writing tests

Create `tests/smoke/login.test`:

```text
@smoke
Test: Login
Navigate to {{env.baseUrl}}/login
Fill username as {{env.credentials.email}}
Fill password as {{env.credentials.password}}
Click Login
Verify Welcome message is visible
```

Reuse shared flows with `@reuse`, and use `{{env.*}}` / `{{keyword}}` for config and dynamic data:

```text
@smoke
@reuse shared/login.test
Fill notes as Order {{unique}}
Verify dashboard is displayed
```

See **[Writing tests](docs/WRITING_TESTS.md)** for `@reuse`, all utility keywords (`{{unique}}`, `{{random_email}}`, …), and preprocessing rules.

Run:

```bash
npx opensecant --tag smoke
npx opensecant login
npx opensecant --parallel 4 --tag smoke
```

## QA agent

```bash
# Goal-driven agent
npx opensecant --agent "On https://example.com complete the contact form" --agent-name contact

# Site exploration
npx opensecant --explore "https://example.com" --explore-name demo

# Structured comprehensive QA (see examples/qa-agent/prompt.example.txt)
npx opensecant --comprehensive-qa examples/qa-agent/promptExample.md
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Description |
|----------|-------------|
| `OPENSECANT_BASE_URL` | Application URL |
| `OPENSECANT_EMAIL` / `OPENSECANT_PASSWORD` | Test credentials |
| `OPENSECANT_BROWSER` | `chromium`, `chrome`, `edge`, `firefox`, `webkit` |
| `OPENSECANT_NUM_WORKERS` | Parallel test workers |
| `AI_HEALING_ENABLED` | Enable/disable LLM healing |
| `LLM_PROVIDER` | `bedrock`, `openai`, `ollama`, `azure` |

## Project layout

```
src/
  cli/          Command-line entry points
  engines/      Locator, healing, agent, NLP
  runner/       Test execution pipeline
  store/        Step and memory stores
  providers/    LLM and browser providers
  reporting/    HTML/JSON reports
  config/       Environment and framework settings
tests/          .test suites
data/           stepstore.json cache
docs/           Architecture and guides
```

## Documentation

- [Writing tests](docs/WRITING_TESTS.md) — `@reuse`, `{{env.*}}`, utility keywords
- [Architecture](docs/ARCHITECTURE.md)
- [Action library patterns](docs/ACTION_LIBRARY.md)
- [QA agent](docs/QA_AGENT.md)
- [Contributing](docs/CONTRIBUTING.md)
- [Roadmap](docs/ROADMAP.md)

## License

ISC — see [LICENSE](LICENSE).
