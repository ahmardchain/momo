"""Momo analyzer: compare node receipts to calibration fingerprints.

Inputs
  --refs  DIR   calibration receipts (each has requested_variant = true label; produced on GPUs you trust/verified)
  --nodes DIR   receipts collected from random Nosana nodes
  --out   DIR   report.json + charts/*.png

Metrics (per node receipt vs the reference of the variant it was PAID for)
  exact_match_rate   share of prompts whose output text sha256 equals the reference
  mean_abs_dlogprob  mean |logprob(node) - logprob(ref)| for the chosen token, over the shared token prefix
  topk_jaccard       mean overlap of top-k token sets over the shared prefix
  first_divergence   mean token index where output first differs (len if never)
Classifier
  nearest-centroid on [exact_match_rate, mean_abs_dlogprob] against every variant's references
  -> predicted_variant; verdict = OK | SUBSTITUTED (pred != requested) | DRIFT (pred ok but exact<threshold)
  accuracy reported by leave-one-out over the calibration set (needs >=2 refs per variant).
"""
import argparse, glob, json, math, os, statistics as st

def load(d):
    out = []
    for p in sorted(glob.glob(os.path.join(d, "*.json"))):
        r = json.load(open(p)); r["_file"] = os.path.basename(p); out.append(r)
    return out

def compare(a, b):
    """Distance features of receipt a against receipt b."""
    bi = {it["id"]: it for it in b["items"]}
    em, dl, jac, fd, n = 0, [], [], [], 0
    for it in a["items"]:
        ref = bi.get(it["id"])
        if not ref: continue
        n += 1
        em += it["sha256"] == ref["sha256"]
        div = None
        for k, (s1, s2) in enumerate(zip(it["steps"], ref["steps"])):
            if s1["lp"] is not None and s2["lp"] is not None:
                dl.append(abs(s1["lp"] - s2["lp"]))
            t1, t2 = {t for t, _ in s1["top"]}, {t for t, _ in s2["top"]}
            if t1 | t2: jac.append(len(t1 & t2) / len(t1 | t2))
            if s1["t"] != s2["t"]:
                div = k; break
        fd.append(div if div is not None else min(len(it["steps"]), len(ref["steps"])))
    if n == 0: raise ValueError("no overlapping prompts (different prompt set?)")
    return {"n": n, "exact_match_rate": em / n,
            "mean_abs_dlogprob": st.fmean(dl) if dl else float("nan"),
            "topk_jaccard": st.fmean(jac) if jac else float("nan"),
            "first_divergence": st.fmean(fd)}

def feat(c): return (c["exact_match_rate"], c["mean_abs_dlogprob"])

def classify(r, refs, exclude=None):
    """Nearest variant by mean feature distance to that variant's references."""
    best, scores = None, {}
    for v in sorted({x["requested_variant"] for x in refs}):
        group = [x for x in refs if x["requested_variant"] == v and x is not exclude]
        if not group: continue
        ds = []
        for g in group:
            e, d = feat(compare(r, g))
            ds.append(math.hypot(1 - e, d))  # 0 == identical
        scores[v] = st.fmean(ds)
    best = min(scores, key=scores.get)
    return best, scores

def loo_accuracy(refs):
    rows, correct = [], 0
    for r in refs:
        same = [x for x in refs if x["requested_variant"] == r["requested_variant"] and x is not r]
        if not same: continue
        pred, _ = classify(r, refs, exclude=r)
        rows.append((r["_file"], r["requested_variant"], pred)); correct += pred == r["requested_variant"]
    return (correct / len(rows) if rows else None), rows

def gpu_name(r):
    rows = r.get("gpu", {}).get("rows") or ["?"]
    return rows[0].split(",")[0].strip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refs", required=True); ap.add_argument("--nodes", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--drift-threshold", type=float, default=0.9)
    a = ap.parse_args()
    refs, nodes = load(a.refs), load(a.nodes)
    psha = {r["prompts_sha256"] for r in refs + nodes}
    if len(psha) > 1: print("WARNING: receipts use different prompt sets:", psha)
    synthetic = any(r.get("synthetic") for r in refs + nodes)
    acc, loo = loo_accuracy(refs)
    results = []
    for r in nodes:
        req = r["requested_variant"]
        same = [x for x in refs if x["requested_variant"] == req]
        cmp_ = [compare(r, g) for g in same]
        agg = {k: st.fmean(c[k] for c in cmp_) for k in ("exact_match_rate", "mean_abs_dlogprob", "topk_jaccard", "first_divergence")}
        pred, scores = classify(r, refs)
        verdict = "SUBSTITUTED" if pred != req else ("DRIFT" if agg["exact_match_rate"] < a.drift_threshold else "OK")
        results.append({"file": r["_file"], "gpu": gpu_name(r), "requested": req, "predicted": pred,
                        "verdict": verdict, "scores": scores, **agg,
                        "tok_per_s": r.get("timing", {}).get("tok_per_s")})
    summary = {"synthetic_test_data": synthetic, "n_refs": len(refs), "n_nodes": len(nodes),
               "classifier_loo_accuracy": acc, "loo": loo,
               "verdicts": {v: sum(x["verdict"] == v for x in results) for v in ("OK", "DRIFT", "SUBSTITUTED")},
               "nodes": results}
    os.makedirs(a.out, exist_ok=True)
    json.dump(summary, open(os.path.join(a.out, "report.json"), "w"), indent=2)
    charts(summary, refs, a.out)
    print(json.dumps({k: summary[k] for k in ("synthetic_test_data", "n_refs", "n_nodes", "classifier_loo_accuracy", "verdicts")}, indent=2))

def charts(s, refs, out):
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    cd = os.path.join(out, "charts"); os.makedirs(cd, exist_ok=True)
    tag = "  [SYNTHETIC TEST DATA]" if s["synthetic_test_data"] else ""
    ns = s["nodes"]; labels = [f'{x["file"][:18]}\n{x["gpu"][:14]}' for x in ns]
    col = {"OK": "#2a9d8f", "DRIFT": "#e9c46a", "SUBSTITUTED": "#e63946"}
    fig, ax = plt.subplots(figsize=(max(6, len(ns) * .6), 4))
    ax.bar(range(len(ns)), [x["exact_match_rate"] for x in ns], color=[col[x["verdict"]] for x in ns])
    ax.set_xticks(range(len(ns))); ax.set_xticklabels(labels, rotation=75, fontsize=6)
    ax.set_ylim(0, 1.05); ax.set_ylabel("exact output match vs paid-for reference"); ax.set_title("Per-node exact match" + tag)
    fig.tight_layout(); fig.savefig(os.path.join(cd, "exact_match.png"), dpi=150); plt.close(fig)
    fig, ax = plt.subplots(figsize=(6, 4))
    for v in sorted({x["requested"] for x in ns}):
        pts = [x for x in ns if x["requested"] == v]
        ax.scatter([x["mean_abs_dlogprob"] for x in pts], [x["exact_match_rate"] for x in pts], label=f"paid {v}", alpha=.8)
    ax.set_xlabel("mean |Δ logprob| vs reference"); ax.set_ylabel("exact match"); ax.legend(); ax.set_title("Fingerprint space" + tag)
    fig.tight_layout(); fig.savefig(os.path.join(cd, "fingerprint_scatter.png"), dpi=150); plt.close(fig)
    vs = sorted({r["requested_variant"] for r in refs})
    m = []
    for i in vs:
        row = []
        for j in vs:
            ds = [feat(compare(a, b))[1] for a in refs if a["requested_variant"] == i
                  for b in refs if b["requested_variant"] == j and b is not a]
            row.append(st.fmean(ds) if ds else 0.0)
        m.append(row)
    fig, ax = plt.subplots(figsize=(4.5, 4)); im = ax.imshow(m, cmap="viridis")
    ax.set_xticks(range(len(vs))); ax.set_xticklabels(vs); ax.set_yticks(range(len(vs))); ax.set_yticklabels(vs)
    for i in range(len(vs)):
        for j in range(len(vs)): ax.text(j, i, f"{m[i][j]:.3f}", ha="center", va="center", color="w", fontsize=8)
    fig.colorbar(im); ax.set_title("Calibration |Δlogprob| matrix" + tag, fontsize=9)
    fig.tight_layout(); fig.savefig(os.path.join(cd, "calibration_matrix.png"), dpi=150); plt.close(fig)

if __name__ == "__main__":
    main()
