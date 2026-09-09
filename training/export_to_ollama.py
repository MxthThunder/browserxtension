"""
Adapter Merger and Ollama Exporter for ISRO Privacy Qwen
Problem Statement #26171

Merges trained LoRA adapters back into Qwen 2.5 (1.5B) base weights
and prepares the directory for GGUF conversion with llama.cpp.

Usage:
    python training/export_to_ollama.py
"""

import os
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

def main():
    base_model_id = "Qwen/Qwen2.5-1.5B-Instruct"
    adapter_dir = os.path.join(os.path.dirname(__file__), "output_lora_qwen1.5b")
    merged_output_dir = os.path.join(os.path.dirname(__file__), "merged_isro_qwen1.5b")

    if not os.path.exists(adapter_dir):
        print(f"Error: Adapter directory not found at {adapter_dir}")
        print("Run training/train_lora.py first to generate adapters.")
        return

    print(f"Loading base model: {base_model_id}...")
    tokenizer = AutoTokenizer.from_pretrained(base_model_id, trust_remote_code=True)
    base_model = AutoModelForCausalLM.from_pretrained(
        base_model_id,
        torch_dtype=torch.float16,
        device_map="auto",
        trust_remote_code=True
    )

    print(f"Merging LoRA adapters from {adapter_dir}...")
    lora_model = PeftModel.from_pretrained(base_model, adapter_dir)
    merged_model = lora_model.merge_and_unload()

    print(f"Saving merged standalone model to: {merged_output_dir}...")
    merged_model.save_pretrained(merged_output_dir)
    tokenizer.save_pretrained(merged_output_dir)

    print("\n[OK] Merged model saved successfully!")
    print("\nNext Steps to load into Ollama:")
    print("1. Convert to GGUF using llama.cpp:")
    print(f"   python llama.cpp/convert_hf_to_gguf.py {merged_output_dir} --outtype q4_k_m --outfile training/isro-privacy-qwen.gguf")
    print("2. Create Ollama Model:")
    print("   ollama create isro-privacy-qwen -f training/Modelfile.isro-privacy-qwen")

if __name__ == "__main__":
    main()
