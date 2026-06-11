# Fine-tuning the bot brain on its own successful gameplay

The goal: a small local model (Qwen3-8B) fine-tuned on this team's own
successful strategic decisions — the same approach as mindcraft's "Andy"
models. A specialized 8B that knows THIS codebase's actions/params can
replace the general 35B MoE for strategic decisions, cutting latency ~3x
and demonstrating measurable self-improvement.

## How data is collected (already running)

Every strategic decision is logged to `logs/trajectories/<session>.jsonl`
with the exact prompt, the decision, and whether the resulting action
succeeded (`src/bot/trajectory.ts`). Just let the bots play.

## Overnight run checklist

1. Stop the bots and free the GPU:
   ```bash
   pkill -f "src/index.ts"
   ollama stop qwen3.6:35b-a3b
   ```
2. Build the dataset (wants 200+ examples; more is better):
   ```bash
   node scripts/extract-finetune-dataset.mjs
   ```
3. One-time environment setup:
   ```bash
   python3 -m venv finetune/.venv && source finetune/.venv/bin/activate
   pip install "unsloth[cu128]" trl datasets
   ```
4. Train (1–3 h on the RTX 5090):
   ```bash
   python finetune/train_lora.py
   ```
5. Convert to GGUF and register with ollama:
   ```bash
   pip install gguf
   git clone --depth 1 https://github.com/ggml-org/llama.cpp /tmp/llama.cpp
   python /tmp/llama.cpp/convert_hf_to_gguf.py finetune/qwen3-8b-minecraft-lora-merged \
     --outfile finetune/qwen3-8b-minecraft.gguf --outtype q8_0
   printf 'FROM ./qwen3-8b-minecraft.gguf\n' > finetune/Modelfile
   ollama create qwen3-minecraft:8b -f finetune/Modelfile
   ```
6. A/B test it as the strategic model:
   ```bash
   # .env: OLLAMA_MODEL=qwen3-minecraft:8b  (leave FAST_MODEL on the MoE)
   npm start
   ```
   Compare `logs/sessions/<id>.json` scoreboards (time-to-first-tool,
   action success rate, stash throughput) against the MoE baseline. If
   worse, revert .env — nothing else changed.
