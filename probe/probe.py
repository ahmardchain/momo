"""Momo GPU honesty probe. Runs inside the vLLM container on a Nosana node.

Loads MODEL_PATH with vLLM, runs the fixed prompt set at temperature 0, and emits a
JSON receipt: per-prompt output-text sha256, generated token ids, top-k logprobs,
plus nvidia-smi / driver / vLLM / torch versions. The receipt is printed to stdout
as gzip+base64 chunks between markers so it can be recovered from job logs.

Env:
  MODEL_PATH   local path or HF id (required)
  VARIANT      label you *requested*, e.g. fp16 | awq | q4   (required)
  QUANT        vLLM quantization arg ("" for none, "awq", "gguf")
  DTYPE        default float16
  TOKENIZER    tokenizer id/path (needed for GGUF)
  PROMPTS_URL  url of prompts.json (default: pinned in repo)
  MAX_TOKENS   default 64 ; TOP_K default 5 ; MAX_MODEL_LEN default 2048
  OUT          optional file path to also write the receipt
"""
import base64, gzip, hashlib, json, os, platform, subprocess, sys, time, urllib.request

def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception as e:  # noqa
        return f"ERR {e}"

def gpu_info():
    q = "name,driver_version,memory.total,pci.bus_id,uuid,compute_cap,power.limit,clocks.max.sm"
    rows = sh(f"nvidia-smi --query-gpu={q} --format=csv,noheader")
    return {"query": q, "rows": rows.splitlines(), "smi_header": sh("nvidia-smi | head -4"),
            "cuda_visible": os.environ.get("CUDA_VISIBLE_DEVICES")}

def load_prompts():
    url = os.environ.get("PROMPTS_URL")
    if url:
        raw = urllib.request.urlopen(url, timeout=60).read().decode()
    else:
        raw = open(os.path.join(os.path.dirname(__file__), "prompts.json")).read()
    return json.loads(raw), hashlib.sha256(raw.encode()).hexdigest()

def emit(receipt):
    blob = base64.b64encode(gzip.compress(json.dumps(receipt).encode())).decode()
    n = 3000
    chunks = [blob[i:i+n] for i in range(0, len(blob), n)]
    print(f"===GHRECEIPT BEGIN {len(chunks)} {hashlib.sha256(blob.encode()).hexdigest()}===", flush=True)
    for i, c in enumerate(chunks):
        print(f"GHR {i:05d} {c}", flush=True)
    print("===GHRECEIPT END===", flush=True)

def main():
    t0 = time.time()
    from vllm import LLM, SamplingParams
    import vllm, torch
    prompts, psha = load_prompts()
    model = os.environ["MODEL_PATH"]
    quant = os.environ.get("QUANT") or None
    kw = dict(model=model, dtype=os.environ.get("DTYPE", "float16"), quantization=quant,
              max_model_len=int(os.environ.get("MAX_MODEL_LEN", 2048)), seed=0,
              enforce_eager=os.environ.get("EAGER", "0") == "1")
    if os.environ.get("TOKENIZER"):
        kw["tokenizer"] = os.environ["TOKENIZER"]
    llm = LLM(**kw)
    t_load = time.time() - t0
    k = int(os.environ.get("TOP_K", 5))
    sp = SamplingParams(temperature=0.0, max_tokens=int(os.environ.get("MAX_TOKENS", 64)), logprobs=k, seed=0)
    tok = llm.get_tokenizer()
    texts = [tok.apply_chat_template([{"role": "user", "content": p["prompt"]}], tokenize=False, add_generation_prompt=True) for p in prompts]
    t1 = time.time()
    outs = llm.generate(texts, sp)
    t_gen = time.time() - t1
    items, ntok = [], 0
    for p, o in zip(prompts, outs):
        c = o.outputs[0]
        ntok += len(c.token_ids)
        steps = []
        for tid, lp in zip(c.token_ids, c.logprobs or []):
            top = sorted(((int(t), float(v.logprob)) for t, v in lp.items()), key=lambda x: -x[1])[:k]
            steps.append({"t": int(tid), "lp": float(lp[tid].logprob) if tid in lp else None, "top": top})
        items.append({"id": p["id"], "sha256": hashlib.sha256(c.text.encode()).hexdigest(),
                      "text": c.text, "tokens": [int(t) for t in c.token_ids], "steps": steps})
    receipt = {
        "schema": "momo/receipt/v1",
        "requested_variant": os.environ["VARIANT"],
        "model": model, "quantization": quant, "dtype": kw["dtype"],
        "prompts_sha256": psha, "n_prompts": len(prompts), "top_k": k,
        "env": {"vllm": vllm.__version__, "torch": torch.__version__, "cuda": torch.version.cuda,
                "python": platform.python_version(), "host": platform.node(),
                "nosana_job": os.environ.get("NOSANA_JOB_ID") or os.environ.get("JOB_ID")},
        "gpu": gpu_info(),
        "timing": {"load_s": round(t_load, 2), "gen_s": round(t_gen, 2), "gen_tokens": ntok,
                   "tok_per_s": round(ntok / t_gen, 1) if t_gen else None},
        "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "items": items,
    }
    if os.environ.get("OUT"):
        json.dump(receipt, open(os.environ["OUT"], "w"))
    emit(receipt)
    print("GHR DONE", round(time.time() - t0, 1), "s", file=sys.stderr, flush=True)

if __name__ == "__main__":
    main()
