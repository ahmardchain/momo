"""Build ONE Nosana job that runs all three variants (fp16, awq, q4) back-to-back on the same GPU.

Why one job: the node gets a single container and can't tell which run is the 'reference';
cross-variant differences on the SAME hardware give a clean quantization fingerprint,
and repeating it on 2-3 GPU types (3090/4090/A100) measures hardware jitter separately.
Strongly recommended: also run `calibration/run_local.sh` on one GPU you control (Colab/own box)
as a trust anchor — receipts from it are labelled trusted=true.

Usage: python3 calibration/build_calibration_job.py --commit <sha> [--market addr] [--timeout-min 75]
"""
import argparse, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "nosana"))
from build_jobs import job_definition  # noqa

ap = argparse.ArgumentParser(); ap.add_argument("--commit", required=True)
ap.add_argument("--market", default="<MARKET_ADDRESS>"); ap.add_argument("--timeout-min", type=int, default=75)
a = ap.parse_args()
cfg = json.loads((ROOT / "nosana/variants.json").read_text())
jobs = {v: job_definition(v, cfg, a.commit) for v in cfg["variants"]}
base = jobs["fp16"]; op = base["ops"][0]["args"]
boot_fetch = op["cmd"][0].split("nvidia-smi || true;")[0]
runs = []
for v, jd in jobs.items():
    e = jd["ops"][0]["args"]["env"]
    envs = " ".join(f'{k}="{val}"' for k, val in e.items())
    runs.append(f"env {envs} VARIANT=calib-{v} python3 /tmp/probe.py")
op["cmd"] = [boot_fetch + "nvidia-smi || true; " + " ; ".join(runs)]
op["resources"] = [jd["ops"][0]["args"]["resources"][0] for jd in jobs.values()]
op["env"] = {}
base["ops"][0]["id"] = "momo-calibration"
base["meta"]["system_requirements"]["required_vram"] = 22
out = ROOT / "nosana/generated"; out.mkdir(exist_ok=True)
(out / "job-calibration.json").write_text(json.dumps(base, indent=2))
(out / "deployment-calibration.json").write_text(json.dumps({"name": "momo-calibration", "market": a.market, "replicas": 1,
    "timeout": a.timeout_min, "strategy": "SIMPLE", "job_definition": base}, indent=2))
print("wrote nosana/generated/job-calibration.json and deployment-calibration.json")
