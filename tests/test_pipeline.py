import json, subprocess, sys, pathlib, base64, gzip, hashlib
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "probe"))
def test_decode_roundtrip(tmp_path):
    from decode_logs import decode
    r = {"hello": "momo", "x": list(range(5000))}
    blob = base64.b64encode(gzip.compress(json.dumps(r).encode())).decode()
    ch = [blob[i:i+3000] for i in range(0, len(blob), 3000)]
    log = "noise\n" + f"===GHRECEIPT BEGIN {len(ch)} {hashlib.sha256(blob.encode()).hexdigest()}===\n" + \
          "\n".join(f"[op] GHR {i:05d} {c}" for i, c in enumerate(ch)) + "\n===GHRECEIPT END===\n"
    assert decode(log) == r
def test_analyzer_on_synthetic(tmp_path):
    subprocess.run([sys.executable, ROOT/"tests/make_synthetic.py", tmp_path/"s"], check=True)
    subprocess.run([sys.executable, ROOT/"analyzer/analyze.py", "--refs", tmp_path/"s/refs", "--nodes", tmp_path/"s/nodes", "--out", tmp_path/"o"], check=True)
    rep = json.load(open(tmp_path/"o/report.json"))
    assert rep["synthetic_test_data"] is True
    assert rep["classifier_loo_accuracy"] == 1.0
    sub = {n["file"] for n in rep["nodes"] if n["verdict"] == "SUBSTITUTED"}
    assert sub == {"node-09-paidfp16.json", "node-10-paidfp16.json"}
    for c in ("exact_match.png", "fingerprint_scatter.png", "calibration_matrix.png"):
        assert (tmp_path/"o/charts"/c).stat().st_size > 1000
def test_prompts_fixed():
    p = json.load(open(ROOT/"probe/prompts.json")); assert len(p) == 200 and len({x["id"] for x in p}) == 200
def test_job_build(tmp_path):
    subprocess.run([sys.executable, ROOT/"nosana/build_jobs.py", "--commit", "abc123"], check=True)
    d = json.load(open(ROOT/"nosana/generated/deployment-fp16.json"))
    assert d["strategy"] == "SIMPLE" and d["timeout"] == 40
    a = d["job_definition"]["ops"][0]["args"]; assert a["gpu"] and "probe verified" in a["cmd"][0]
