"""SYNTHETIC TEST DATA ONLY. Fabricates receipts so the analyzer can be tested without a GPU.
Every file is marked "synthetic": true and charts are watermarked. Never publish these as results."""
import hashlib, json, os, random, sys
NOISE = {"fp16": 0.0, "awq": 0.35, "q4": 0.6}     # pretend per-variant logprob perturbation
FLIP = {"fp16": 0.0, "awq": 0.25, "q4": 0.45}     # pretend chance a token choice flips
def base(seed=1, n=200, L=24, V=500):
    rnd = random.Random(seed)
    return [[[(rnd.randrange(V), -abs(rnd.gauss(0, 2))) for _ in range(5)] for _ in range(L)] for _ in range(n)]
def receipt(variant, gpu, seed, B, jitter=0.01):
    # variant effect is DETERMINISTIC per variant (like real quantization); per-run jitter is small (like GPU kernels)
    vr = random.Random(hash(variant) % 10**6 if False else {"fp16": 1, "awq": 2, "q4": 3}[variant]); rnd = random.Random(seed); items = []
    for i, prompt in enumerate(B):
        steps, toks = [], []
        for top in prompt:
            top = sorted(top, key=lambda x: -x[1])
            if vr.random() < FLIP[variant] / len(prompt) * 3: top = top[1:] + top[:1]
            top = [(t, lp + vr.gauss(0, NOISE[variant]) + rnd.gauss(0, jitter)) for t, lp in top]
            steps.append({"t": top[0][0], "lp": top[0][1], "top": top}); toks.append(top[0][0])
        items.append({"id": f"p-{i:03d}", "sha256": hashlib.sha256(str(toks).encode()).hexdigest(), "text": "", "tokens": toks, "steps": steps})
    return {"schema": "momo/receipt/v1", "synthetic": True, "requested_variant": variant, "prompts_sha256": "SYNTHETIC",
            "gpu": {"rows": [f"{gpu}, 550.00, 24564 MiB"]}, "timing": {"tok_per_s": None}, "items": items}
if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "tests/synthetic"
    B = base(); os.makedirs(f"{out}/refs", exist_ok=True); os.makedirs(f"{out}/nodes", exist_ok=True)
    s = 100
    for v in NOISE:
        for g in ("RTX 4090", "RTX 3090", "A100"):
            s += 1; json.dump(receipt(v, g, s, B), open(f"{out}/refs/ref-{v}-{g.replace(' ','')}.json", "w"))
    # honest nodes + two cheaters (paid fp16, served awq/q4)
    plan = [("fp16", "fp16")] * 6 + [("awq", "awq")] * 3 + [("fp16", "awq"), ("fp16", "q4")]
    for k, (paid, served) in enumerate(plan):
        r = receipt(served, ["RTX 4090", "RTX 3090", "RTX 5090"][k % 3], 900 + k, B); r["requested_variant"] = paid
        json.dump(r, open(f"{out}/nodes/node-{k:02d}-paid{paid}.json", "w"))
    print("SYNTHETIC test receipts written to", out)
