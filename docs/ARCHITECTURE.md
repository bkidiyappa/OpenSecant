# TestWizard — Architecture Guide

## Project Structure

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
│       ├── logger.js               # Colored console logging with timestamps
│       └── uniqueStringGenerator.js # IST-based unique string generation
│
├── tests/                          # Test suites
│   └── smoke/                      # Smoke tests (.test files)
│
├── data/
│   └── stepstore.json              # Persistent step → code mappings
│
├── scripts/
│   ├── cleanup-stepstore.js        # Remove orphaned stepstore entries
│   ├── setup/
│   │   ├── setup-bedrock-env.js    # AWS credentials setup helper
│   │   └── run-parallel-smoke.js   # Standalone parallel smoke runner
│   └── debug/
│       └── debug-find-close-button.js
│
├── reports/                        # Test reports (gitignored)
├── debug-prompts/                  # LLM prompt debug files (gitignored)
└── docs/
    ├── ARCHITECTURE.md             # This file
    └── ACTION_LIBRARY.md           # Action library patterns and scoring
```

## Module Dependency Graph

```
runner.js
  ├── src/core/runner/index.js          (CLI, test discovery)
  │     ├── src/core/runner/testExecutor.js
  │     │     ... (see below)
  │     └── ...
  │
  └── src/core/agent/qaAgent.js         (--agent mode)
        ├── src/core/agent/actionPlanner.js  (LLM decides next action)
        ├── src/core/agent/testGenerator.js  (generates .test + report)
        ├── src/ai/localengine/actionLibrary.js
        ├── src/ai/localengine/codeGenerator.js
        ├── src/ai/localengine/pageDataCapture.js
        └── src/core/stepStore.js

Test Runner dependency detail:
  src/core/runner/index.js
        ├── src/core/runner/testExecutor.js
        │     ├── src/core/runner/stepPreprocessor.js  (, {{env}}, {{keyword}})
        │     ├── src/core/runner/stepExecutor.js
        │     │     ├── src/core/stepStore.js                (step → code cache)
        │     │     ├── src/ai/localengine/actionLibrary.js  (deterministic patterns)
        │     │     ├── src/ai/localengine/codeGenerator.js  (LLM fallback)
        │     │     │     ├── src/ai/localengine/pageDataCapture.js
        │     │     │     ├── src/ai/localengine/elementFiltering.js
        │     │     │     └── src/ai/llm/*                   (provider abstraction)
        │     │     └── src/ai/localengine/pageDataCapture.js
        │     ├── src/core/runner/performanceOptimizer.js
        │     └── src/core/reporting/reportGenerator.js
        ├── src/core/runner/parallelExecutor.js
        │     └── src/core/runner/testWorker.js
        └── src/core/runner/testReader.js
```

## Test Execution Flow

1. **`runner.js`** → Loads env config, initializes logger, calls `src/core/runner`
2. **`src/core/runner/index.js`** → Parses CLI args, discovers test files, routes to sequential or parallel
3. **`src/core/runner/testExecutor.js`** → Launches browser, preprocesses steps, iterates, writes HTML reports
4. **`src/core/runner/stepPreprocessor.js`** → Expands ``, substitutes `{{env.x}}` and `{{keyword}}`
5. **`src/core/runner/stepExecutor.js`** → Resolves each step: StepStore → Action Library → LLM

## Step Resolution Order

```
Step: "Fill email as demo.user@example.com"
  │
  ├─ 1. StepStore lookup (data/stepstore.json)
  │     Hit? → Execute cached Playwright code
  │
  ├─ 2. Action Library (deterministic, no LLM)
  │     Pattern match → Score elements → Generate candidates → Try each
  │
  └─ 3. LLM Fallback (Bedrock/OpenAI/Ollama)
        Capture page elements → Build prompt → Try suggestions → Cache working code
```

## Step store and parallel runs

When tests run in **parallel** (`worker_threads`), each worker has its own `StepStore` instance. Successful steps call `StepStore#set`, which must **read the latest `data/stepstore.json` and merge** on every write. Otherwise the last worker to save would overwrite the file with only its own keys and **drop** mappings learned by other workers (e.g. a 4-step test losing all entries when a 2-step test saved last). `StepStore#resolve` also checks disk when a key is missing in memory so workers can reuse keys written by a sibling during the same run.

## Step Preprocessing

Before execution, `src/runner/stepPreprocessor.js` processes each step in order:

1. **`@reuse login.test`** — Inlines steps from another `.test` file (searches `tests/` and subfolders).
2. **`{{env.credentials.email}}`** — Values from `src/config/envConfig.js` for the active `--env`.
3. **`{{unique}}`, `{{random_email}}`, …** — Dynamic keywords generated at run time.

Reports show both original and resolved text when substitutions occur.

Full reference: [Writing tests](WRITING_TESTS.md).

## QA Agent Mode

The agent autonomously explores a website toward a goal:

```
Goal: "On https://example.com perform a booking"
  │
  ├─ 1. Navigate to URL
  ├─ 2. Capture page elements (hybrid data capture)
  ├─ 3. Ask Action Planner LLM: "What's the next step?"
  │     → LLM returns: "close the offer modal if it is open"
  ├─ 4. Execute step via: StepStore → Action Library → LLM code gen
  ├─ 5. Record { step, code, source } if successful
  ├─ 6. Repeat from step 2 until GOAL_COMPLETE or max steps
  └─ 7. Generate .test file + agent report
```

The planner and code generator use **separate LLM calls**:
- **Planner**: decides *what* to do (natural language step)
- **Code generator**: decides *how* to do it (Playwright code)

## Adding New LLM Providers

1. Create `src/ai/llm/providers/yourProvider.js` extending `LLMProvider`
2. Register in `src/ai/llm/llmFactory.js`
3. Add config in `src/ai/llm/llmConfig.js`
4. Set `LLM_PROVIDER=your-provider` environment variable

## System requirements

Node.js 18+, Playwright browsers, and an LLM provider for healing/agent features. **Local LLMs (Ollama) require a 6+ GB GPU.** See [System requirements](SYSTEM_REQUIREMENTS.md).

## NPM Scripts

| Script | Command |
|--------|---------|
| `npm test` | Run all tests |
| `npm run smoke` | Run smoke tests |
| `npm run smoke:parallel` | Run smoke tests in parallel |
| `npm run test:parallel` | Run all tests in parallel |
| `npm run test:dev` | Run with develop environment |
| `npm run test:release` | Run with release environment |
