"""Build Nosana job definitions (and SIMPLE-strategy deployment bodies) for each model variant.

The container is the stock vLLM image; at start it downloads probe.py + prompts.json from
this repo at a PINNED commit and refuses to run if their sha256 doesn't match. So a node
can't swap the probe, and anyone can audit exactly what ran.

Usage: python3 nosana/build_jobs.py --commit <git sha> [--market <addr>] [--timeout-min 40]
"""
import argparse, hashlib, json, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]

def sha(p): return hashlib.sha256((ROOT / p).read_bytes()).hexdigest()

def job_definition(variant, cfg, commit):
    v = cfg["variants"][variant]
    base = f'{cfg["repo_raw"]}/{commit}'
    boot = (
        "set -e; cd /tmp; "
        f"python3 - <<'PY'\n"
        "import hashlib,urllib.request,sys\n"
        f"for name,url,want in [('probe.py','{base}/probe/probe.py','{sha('probe/probe.py')}'),"
        f"('prompts.json','{base}/probe/prompts.json','{sha('probe/prompts.json')}')]:\n"
        "    b=urllib.request.urlopen(url,timeout=60).read()\n"
        "    got=hashlib.sha256(b).hexdigest()\n"
        "    if got!=want: sys.exit(f'sha mismatch {name} {got}')\n"
        "    open(name,'wb').write(b)\n"
        "print('probe verified')\n"
        "PY\n"
        "nvidia-smi || true; python3 /tmp/probe.py"
    )
    res = {"type": "HF", "repo": v["repo"], "target": v["target"]}
    if v.get("files"): res["files"] = v["files"]
    return {
        "version": "0.1", "type": "container",
        "global": {"entrypoint": ["/bin/bash", "-c"]},
        "meta": {"trigger": "api", "system_requirements": {"required_vram": v["required_vram"]}},
        "ops": [{
            "type": "container/run", "id": f"momo-{variant}",
            "args": {
                "image": cfg["image"], "gpu": True,
                "entrypoint": ["/bin/bash", "-c"], "cmd": [boot],
                "env": {"MODEL_PATH": v["model_path"], "VARIANT": variant, "QUANT": v["quant"],
                        "TOKENIZER": v["tokenizer"], "DTYPE": "float16", "MAX_TOKENS": "64", "TOP_K": "5",
                        "MAX_MODEL_LEN": "2048", "HF_HUB_OFFLINE": "0"},
                "resources": [res],
            },
        }],
    }

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", required=True)
    ap.add_argument("--market", default="<MARKET_ADDRESS>")
    ap.add_argument("--timeout-min", type=int, default=40)
    a = ap.parse_args()
    cfg = json.loads((ROOT / "nosana/variants.json").read_text())
    out = ROOT / "nosana/generated"; out.mkdir(exist_ok=True)
    for name in cfg["variants"]:
        jd = job_definition(name, cfg, a.commit)
        (out / f"job-{name}.json").write_text(json.dumps(jd, indent=2))
        dep = {"name": f"momo-{name}", "market": a.market, "replicas": 1,
               "timeout": a.timeout_min, "strategy": "SIMPLE", "job_definition": jd}
        (out / f"deployment-{name}.json").write_text(json.dumps(dep, indent=2))
    print("wrote", sorted(p.name for p in out.iterdir()))
