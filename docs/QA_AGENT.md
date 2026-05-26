# QA Agent

OpenSecant includes autonomous QA modes for exploration, goal-driven testing, and structured multi-journey QA.

## Modes

### Goal-driven agent

```bash
npx opensecant --agent "On https://example.com complete checkout" --agent-name checkout
```

Options:

- `--agent-name <name>` — output test file base name
- `--agent-max-steps <n>` — max steps per pass (default: 50)
- `--agent-max-flows <n>` — multi-pass exploration count

### Site exploration

```bash
npx opensecant --explore "https://example.com" --explore-name demo --explore-max-pages 20 --explore-max-steps 40
```

1. **Crawls** the site (handles `www` / non-`www`, prioritizes Contact/Demo/Product links)
2. **Detects flows** with heuristics (forms, CTAs) and **LLM** when needed
3. **Runs the QA agent** on each flow to generate `.test` files under `tests/ai/`
4. Writes manifest + report under `reports/`

If no forms are found, a fallback **agent-explore** flow still runs so tests are generated.

### Comprehensive QA

```bash
npx opensecant --comprehensive-qa examples/qa-agent/prompt.example.txt
```

Use a structured prompt file describing personas, journeys, and acceptance criteria. See `examples/qa-agent/prompt.example.txt`.

## How it works

1. **Planner** (`actionPlanner.js`) decides *what* to do next in natural language
2. **Runner pipeline** resolves *how* to do it (StepStore → locator → LLM)
3. **Generator** (`testGenerator.js`) writes `.test` files and markdown reports

Planner and code generation use separate LLM calls for reliability.

## Requirements

- Playwright browsers installed (`npx playwright install`)
- LLM provider configured when steps cannot be resolved deterministically
- Set `AI_HEALING_ENABLED=true` and provider credentials (see `.env.example`)

## Output

- Generated tests under `tests/ai/` or configured output paths
- HTML/markdown reports under `reports/`
- Updated `data/stepstore.json` for reusable step mappings
