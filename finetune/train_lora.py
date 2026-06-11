# LoRA fine-tune of a small Qwen model on the bots' own successful trajectories.
#
# Run OVERNIGHT with the bots stopped (needs the whole GPU):
#   1. pkill -f "src/index.ts"          # stop the bots
#   2. ollama stop qwen3.6:35b-a3b      # free VRAM
#   3. node scripts/extract-finetune-dataset.mjs
#   4. python3 -m venv finetune/.venv && source finetune/.venv/bin/activate
#      pip install "unsloth[cu128]" trl datasets    # one-time
#   5. python finetune/train_lora.py
#   6. Convert + serve via ollama (see finetune/README.md)
#
# RTX 5090 (32GB): Qwen3-8B with 4-bit QLoRA fits comfortably; expect
# ~1-3 hours depending on dataset size.

from unsloth import FastLanguageModel
from trl import SFTConfig, SFTTrainer
from datasets import load_dataset

BASE_MODEL = "unsloth/Qwen3-8B-bnb-4bit"
DATASET = "finetune/dataset.jsonl"
OUTPUT_DIR = "finetune/qwen3-8b-minecraft-lora"

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name=BASE_MODEL,
    max_seq_length=4096,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(
    model,
    r=16,
    lora_alpha=32,
    lora_dropout=0.0,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
)

dataset = load_dataset("json", data_files=DATASET, split="train")


def to_text(example):
    return {
        "text": tokenizer.apply_chat_template(
            example["messages"], tokenize=False, add_generation_prompt=False
        )
    }


dataset = dataset.map(to_text, remove_columns=dataset.column_names)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=SFTConfig(
        output_dir=OUTPUT_DIR,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=8,
        num_train_epochs=2,
        learning_rate=2e-4,
        logging_steps=10,
        save_strategy="epoch",
        bf16=True,
        optim="adamw_8bit",
        report_to="none",
    ),
)

trainer.train()

# Save merged 16-bit weights for GGUF conversion / ollama import
model.save_pretrained_merged(OUTPUT_DIR + "-merged", tokenizer, save_method="merged_16bit")
print(f"Done. Merged model at {OUTPUT_DIR}-merged")
