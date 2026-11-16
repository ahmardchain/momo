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
4. **Budget guard:** `--max-credits` is a **USD** ceiling (the balance API reports cents; the runner converts). Omit `--yes` for a dry run that prints the worst-case cost and posts nothing. Credit-paid jobs need `--timeout-s` of at least **3600** (the API returns 400 below that). Nosana bills actual runtime, and the guard reserves the full timeout so a hung job cannot walk past the cap. An RTX 5090 is about $0.48/h ([credits post](https://hackernoon.com/claim-your-$70-nosana-gpu-credits-for-the-decentralize-ai-hackathon)), so one hour worst-case is about $0.48.

## How to run a live audit

Do this only after the commit you pin is **pushed**. The job downloads `probe.py` from GitHub at that sha; a fake or unpushed sha still starts a GPU and bills the timeout. `pytest` writes job JSON to a temp directory and does not touch `nosana/generated`.

```bash
git clone https://github.com/ahmardchain/momo && cd momo
npm install --ignore-scripts   # if it stalls, install @nosana/kit first, then @ardrive/turbo-sdk arweave
python3 -m venv .venv && .venv/bin/pip install numpy matplotlib pytest
.venv/bin/python -m pytest -q tests                      # synthetic tests, no GPU, no tracked-file writes

export NOSANA_API_KEY=nos_...                            # deploy.nosana.com → API keys. Never commit this.

# pin the job to the pushed commit, then confirm the dry run names that same sha
python3 nosana/build_jobs.py --commit $(git rev-parse HEAD)
python3 calibration/build_calibration_job.py --commit $(git rev-parse HEAD)
node runner/run.mjs --list-markets                       # pick 3090/4090/5090/A100 addresses; note usd_per_hour

# 1) calibration: fp16+awq+q4 on the same card. 4500s is above the 3600s minimum.
#    Without --yes this only prints the worst-case USD. Read it before adding --yes.
node runner/run.mjs --variant calibration --markets <4090>,<3090> --per-market 1 --timeout-s 4500 --max-credits 10
node runner/run.mjs --variant calibration --markets <4090>,<3090> --per-market 1 --timeout-s 4500 --max-credits 10 --yes
python3 calibration/split_receipts.py data/raw-<JOB>.json --tag <JOB>
#    optional trust anchor on a GPU you control: bash calibration/run_local.sh

# 2) the audit. --max-credits 40 means stop at $40, not 40 cents and not 4000 cents.
#    Dry run (no --yes) prints jobs-that-fit, worst-case USD per job, and the total.
#    It posts nothing. Add --yes only if that total is inside the cap and the balance.
node runner/run.mjs --variant fp16 --markets <m1>,<m2>,<m3> --per-market 4 --timeout-s 3600 --max-credits 40
node runner/run.mjs --variant fp16 --markets <m1>,<m2>,<m3> --per-market 4 --timeout-s 3600 --max-credits 40 --yes

# 3) analyze + publish. Uploads over the Turbo free tier (105 KiB per item, 10 MiB lifetime)
#    abort with an error instead of charging the wallet. Fetch checks chunk and receipt sha256.
.venv/bin/python analyzer/analyze.py --refs data/refs --nodes data/nodes --out results
node arweave/upload.mjs data/refs && node arweave/upload.mjs data/nodes
node arweave/fetch.mjs <manifest_txid>
```

Budget sketch: the runner's worst case is the full `--timeout-s`, not the 5–10 minutes a healthy FP16 run usually takes. At about $0.48/h, a 3600s audit job reserves about $0.48 and a 4500s calibration job about $0.60. Twelve audit jobs plus two calibration jobs are about $7 worst-case, inside a `--max-credits 40` ceiling and the $70 pot. If the dry run says `jobs that fit` is less than `requested jobs`, lower `--per-market` or raise `--max-credits` before `--yes`. A second `--yes` posts another batch. Ctrl-C stops jobs already posted so they do not run out the timeout.

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
