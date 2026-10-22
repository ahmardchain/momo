#!/usr/bin/env bash
# Trust-anchor calibration on a GPU you control (24 GB+, e.g. Colab L4/A100, or your own 3090/4090).
# Needs: pip install vllm==0.6.6 huggingface_hub ; ~30 GB disk.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/calib-local
huggingface-cli download unsloth/Meta-Llama-3.1-8B-Instruct --local-dir /tmp/m/fp16
huggingface-cli download hugging-quants/Meta-Llama-3.1-8B-Instruct-AWQ-INT4 --local-dir /tmp/m/awq
huggingface-cli download bartowski/Meta-Llama-3.1-8B-Instruct-GGUF Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf --local-dir /tmp/m/q4
{
MODEL_PATH=/tmp/m/fp16 VARIANT=calib-fp16 QUANT= python3 probe/probe.py
MODEL_PATH=/tmp/m/awq  VARIANT=calib-awq QUANT=awq python3 probe/probe.py
MODEL_PATH=/tmp/m/q4/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf VARIANT=calib-q4 QUANT=gguf TOKENIZER=unsloth/Meta-Llama-3.1-8B-Instruct python3 probe/probe.py
} | tee data/calib-local/log.txt
python3 calibration/split_receipts.py data/calib-local/log.txt --tag local --trusted
