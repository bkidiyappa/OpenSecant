# System Requirements

## Minimum (all setups)

| Requirement | Details |
|-------------|---------|
| **Node.js** | 18 or newer |
| **npm** | Comes with Node.js |
| **OS** | Windows, macOS, or Linux |
| **Disk** | ~500 MB for dependencies + Playwright browsers |
| **Playwright** | Install browsers after `npm install`: `npx playwright install chromium` |

OpenSecant can run **without** an LLM when steps are resolved from the step store or action library (`AI_HEALING_ENABLED=false`). Most real-world suites use an LLM for new steps and self-healing.

---

## LLM provider options

| Provider | What you need |
|----------|----------------|
| **OpenAI** | API key (`OPENAI_API_KEY`), internet access |
| **Azure OpenAI** | Endpoint + API key |
| **AWS Bedrock** | AWS credentials + model access |
| **Ollama (local)** | [Ollama](https://ollama.com) installed + **GPU requirements below** |

Set `LLM_PROVIDER` in `.env` to `openai`, `azure`, `bedrock`, or `ollama`.

---

## Local LLMs (Ollama)

For `LLM_PROVIDER=ollama` (local inference on your machine):

| Requirement | Recommendation |
|-------------|----------------|
| **GPU VRAM** | **6 GB or more** (required for typical code-generation models) |
| **RAM** | 16 GB system RAM minimum; 32 GB recommended for larger models |
| **Ollama** | Latest Ollama installed and running (`ollama serve` or Ollama desktop app) |
| **Model** | Pull a model before running, e.g. `ollama pull llama3` (set `OLLAMA_MODEL` in `.env`) |

Smaller GPUs (under 6 GB VRAM) may fail, run very slowly, or require a much smaller quantized model with reduced quality for step generation and healing.

### Verify Ollama

```bash
ollama list
curl http://localhost:11434/api/tags
```

Configure in `.env`:

```env
LLM_PROVIDER=ollama
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3
AI_HEALING_ENABLED=true
```

---

## Browser automation

| Item | Notes |
|------|--------|
| **Chromium** | Default; installed via Playwright |
| **Chrome / Edge / Firefox** | Optional; use `--browser=chrome` etc. |
| **Headless** | `HEADLESS=true` in `.env` for CI; `false` for local debugging |

---

## Optional

| Feature | Extra needs |
|---------|-------------|
| **Parallel tests** | More CPU/RAM; set `OPENSECANT_NUM_WORKERS` |
| **QA agent / explore** | LLM provider + Playwright; explore mode benefits from GPU if using Ollama |
| **Debug prompts** | `DEBUG_PROMPTS=true`; writes to `debug-prompts/` |

---

## Quick reference

| Use case | GPU |
|----------|-----|
| Tests with cloud LLM (OpenAI / Bedrock / Azure) | Not required |
| Tests with healing disabled (step store only) | Not required |
| **Local LLM via Ollama** | **6+ GB VRAM required** |
