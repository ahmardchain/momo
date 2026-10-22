# Momo — did the random GPU run the model you paid for?

Decentralized GPU networks let anyone rent a stranger's card. Momo measures whether that stranger
actually served the model you asked for — full-precision **Llama 3.1 8B Instruct (FP16)** — or a cheaper
quantized stand-in (**AWQ-INT4**, **GGUF Q4_K_M**), using output and logprob fingerprints.

* **Compute:** one-shot jobs on [Nosana](https://learn.nosana.com) GPU markets (stock `vllm/vllm-openai:v0.6.6` image).
* **Evidence:** every receipt (output hashes, top-5 logprobs, `nvidia-smi`, versions, timings) is stored permanently on
  [Arweave](https://docs.ar.io/build/upload/) via ar.io Turbo, so anyone can re-check the numbers.
* **Status:** code complete and tested locally on **synthetic** data. No real GPU results yet (see *Status*).

Built for HackerNoon's [Decentralize AI Hackathon](https://decentralizeai.tech/).

## How it works

```
prompts.json (200 fixed prompts, sha256-pinned)
      │
      ▼
Nosana job ── fetches probe.py + prompts.json from this repo at a pinned commit, verifies sha256
      │        vLLM, temperature 0, max 64 tokens, top-5 logprobs, seed 0
      ▼
receipt.json (printed to job logs as gzip+base64 chunks → recovered from IPFS results)
      │
      ├── Arweave (gzip, ≤100 KiB chunks + manifest → free tier)
      ▼
analyzer: vs. calibration fingerprints → exact-match rate, |Δlogprob|, top-k Jaccard,
          nearest-variant classifier (leave-one-out accuracy) → verdict OK / DRIFT / SUBSTITUTED + charts
```

| Path | What it does |
|---|---|
| `probe/prompts.json`, `probe/make_prompts.py` | 200 deterministic prompts (arithmetic, facts, code, reasoning, translation) |
| `probe/probe.py` | Runs inside the job: vLLM inference + receipt |
| `probe/decode_logs.py`, `runner/decode.mjs` | Recover a receipt from job logs/results |
| `nosana/variants.json`, `nosana/build_jobs.py` | Generates job definitions + SIMPLE-strategy deployment bodies for fp16/awq/q4 |
| `calibration/` | Reference-fingerprint job (all 3 variants on one GPU), trusted local run, receipt splitter |
| `runner/run.mjs` | Posts N jobs across markets with credits (dry-run by default, `--max-credits` cap) |
| `analyzer/analyze.py` | Metrics, classifier, charts |
| `arweave/upload.mjs`, `arweave/fetch.mjs` | Permanent upload + independent verification |
| `tests/` | Synthetic-data tests (labelled; uploader refuses synthetic files) |
| `post/outline.md` | HackerNoon article outline (numbers marked TBD) |

Nosana formats used: job definition schema (`version 0.1`, `container/run`, `HF` resources, `global.entrypoint`) —
[schema](https://learn.nosana.com/deployments/jobs/job-definition/schema.html); deployment options with `strategy: "SIMPLE"`
and `timeout` in minutes — [options](https://learn.nosana.com/deployments/options.html),
[strategies](https://learn.nosana.com/deployments/strategies.html); API flow `validateJobDefinition → ipfs.pin → api.jobs.list → jobs.get().ipfsResult`
with `@nosana/kit` — [first job](https://learn.nosana.com/api/first-job.html); vLLM template — [vLLM example](https://learn.nosana.com/inference/examples/vllm.html).

## What you (the user) must do

1. **Claim credits:** go to <https://decentralizeai.tech/claim/nosana> and claim the $70 Nosana credits (link this repo).
2. **Nosana account + API key:** sign in at <https://deploy.nosana.com>, confirm the credits show, create an API key, then
   `export NOSANA_API_KEY=nos_...` . (Credits + API key need no Solana wallet; the on-chain CLI path needs SOL+NOS — not used here.)
3. **Arweave wallet (free):** `node arweave/upload.mjs --gen-wallet ~/.momo/arweave-wallet.json` — generated offline, keep it private.
   Uploads ≤105 KiB are free (10 MiB lifetime per wallet) per [ar.io docs](https://docs.ar.io/build/upload/upload-and-verify/).
4. **Budget guard:** never use the dashboard's long-running strategies for this; Momo uses one-shot jobs with a timeout
   (an RTX 5090 is about $0.48/h per the [credits post](https://hackernoon.com/claim-your-$70-nosana-gpu-credits-for-the-decentralize-ai-hackathon)).

## Exact steps

```bash
git clone https://github.com/ahmardchain/momo && cd momo
npm install
python3 -m venv .venv && .venv/bin/pip install numpy matplotlib pytest
.venv/bin/python -m pytest -q tests                      # synthetic tests, no GPU

# pin the job to the pushed commit (the job downloads probe.py from GitHub at this sha)
python3 nosana/build_jobs.py --commit $(git rev-parse HEAD)
python3 calibration/build_calibration_job.py --commit $(git rev-parse HEAD)

node runner/run.mjs --list-markets                        # pick 3090/4090/5090/A100 market addresses

# 1) calibration: one job per GPU type, runs fp16+awq+q4 on the same card (~25-40 min)
#    post nosana/generated/job-calibration.json via the runner (use --variant calibration) or the dashboard
node runner/run.mjs --variant calibration --markets <4090>,<3090> --per-market 1 --timeout-s 4500 --yes
python3 calibration/split_receipts.py data/raw-<JOB>.json --tag <JOB>
#    optional trust anchor on a GPU you control: bash calibration/run_local.sh

# 2) the audit: pay for FP16 on many random nodes
node runner/run.mjs --variant fp16 --markets <m1>,<m2>,<m3> --per-market 4 --max-credits 40        # dry plan
node runner/run.mjs --variant fp16 --markets <m1>,<m2>,<m3> --per-market 4 --max-credits 40 --yes  # spend

# 3) analyze + publish
.venv/bin/python analyzer/analyze.py --refs data/refs --nodes data/nodes --out results
node arweave/upload.mjs data/refs  && node arweave/upload.mjs data/nodes     # txids -> arweave/uploads.jsonl
node arweave/fetch.mjs <manifest_txid>                                        # anyone can verify
```

Budget sketch (estimates, check live prices): an 8B FP16 run is about 5–10 min of model download/load plus about 1–3 min of generation.
At about $0.2–0.5/h, 20 audit jobs plus 2–3 calibration jobs should fit inside $70.

## Status

| Part | State |
|---|---|
| Prompt set, probe, receipt encoding/decoding | ✅ built; decode round-trip tested |
| Job/deployment JSON (SIMPLE, timeout) | ✅ generated; schema-validated with `validateJobDefinition` in runner before posting |
| Calibration plan + scripts | ✅ built; **needs a GPU** |
| Analyzer + charts | ✅ tested on **synthetic** receipts only (`tests/make_synthetic.py`) |
| Arweave uploader | ✅ dry-run tested; real upload needs your wallet |
| Runner | ✅ written against documented `@nosana/kit` API; **untested live, blocked on credits** |

### Limitations
* Fingerprints show *what produced the outputs*, not proof of execution (no TEE/zkML). A node that runs the real model passes.
* Different GPUs and kernels can legitimately differ in later tokens. That's why Momo keeps a separate DRIFT verdict and a per-GPU calibration.
* Synthetic test data only shows that the code works. It says nothing about the real Nosana network.

MIT licensed.
