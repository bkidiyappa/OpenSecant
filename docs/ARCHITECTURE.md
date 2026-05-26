# OpenSecant — Architecture

## Project structure

```
opensecant/
├── src/
│   ├── cli/                     # CLI commands (run, explore, heal, init)
│   ├── engines/
│   │   ├── locator/             # Local + LLM locator intelligence
│   │   ├── healing/             # Self-healing retries and fallbacks
│   │   ├── agent/               # QA autonomous agent
│   │   └── nlp/                 # Natural language → actions
│   ├── runner/                  # Browser launch, step execution, parallelism
│   ├── store/                   # stepStore, locatorStore, memoryStore
│   ├── providers/
│   │   ├── llm/                 # Bedrock, OpenAI, Ollama, Azure
│   │   └── browser/             # Playwright provider
│   ├── reporting/               # HTML + JSON reports
│   ├── config/                  # env + framework config
│   └── utils/
├── tests/
├── data/stepstore.json
├── examples/
└── docs/
```

## Execution flow

1. **`src/index.js`** loads config, initializes logger and browser settings
2. **`src/cli`** routes to test run or agent modes
3. **`src/runner/testExecutor.js`** launches browser and iterates steps
4. **`src/runner/stepPreprocessor.js`** expands `@reuse`, substitutes `{{env.*}}`
5. **`src/runner/stepExecutor.js`** resolves each step

## Step resolution

```
Natural-language step
  │
  ├─ 1. StepStore (data/stepstore.json)
  │
  ├─ 2. Locator resolver (deterministic patterns + DOM scoring)
  │
  └─ 3. LLM engine (Bedrock/OpenAI/Ollama/Azure) with healing retries
```

## Healing pipeline

`src/engines/healing/healingEngine.js` orchestrates:

1. Intent detection via NLP/locator resolver
2. Focused element capture (`domComparer` + `pageDataCapture`)
3. Deterministic candidate execution
4. LLM fallback via `fallbackSelector`
5. Configurable retries via `retryStrategy`

## QA agent

`src/engines/agent/qaAgent.js` loops:

1. Capture page state
2. Ask `actionPlanner` (LLM) for the next step
3. Execute via the same resolution pipeline as the runner
4. Generate `.test` file and report on completion

## Adding an LLM provider

1. Create `src/providers/llm/providers/yourProvider.js` extending `LLMProvider`
2. Register in `src/providers/llm/providerFactory.js`
3. Add config in `src/providers/llm/llmConfig.js`
4. Set `LLM_PROVIDER=your-provider`

## NPM scripts

| Script | Command |
|--------|---------|
| `npm test` | Run all tests |
| `npm run smoke` | Run `@smoke` tests |
| `npm run init` | Scaffold project folders |
| `npm run test:parallel` | Parallel execution |
