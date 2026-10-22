"""A calibration job prints 3 receipts in one log. Split them into data/refs/<variant>-<gpu>-<tag>.json.
Usage: python3 calibration/split_receipts.py <raw-log-or-results.json> [--tag nosanaJOB] [--trusted]"""
import json, re, sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "probe"))
from decode_logs import decode
text = open(sys.argv[1]).read(); tag = sys.argv[sys.argv.index("--tag") + 1] if "--tag" in sys.argv else "local"
out = pathlib.Path(__file__).resolve().parents[1] / "data/refs"; out.mkdir(parents=True, exist_ok=True)
for seg in re.split(r"(?====GHRECEIPT BEGIN)", text)[1:]:
    r = decode(seg); r["requested_variant"] = r["requested_variant"].removeprefix("calib-"); r["trusted"] = "--trusted" in sys.argv
    gpu = re.sub(r"\W+", "", (r["gpu"]["rows"] or ["gpu"])[0].split(",")[0])
    p = out / f'{r["requested_variant"]}-{gpu}-{tag}.json'; p.write_text(json.dumps(r)); print("wrote", p)
