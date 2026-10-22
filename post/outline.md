# HackerNoon post outline — Momo

**Title:** I Paid Random GPUs on Nosana to Run Llama 3.1 8B. Here's How Many Gave Me the Model I Asked For
**Alt:** Momo: Fingerprinting Whether a Decentralized GPU Served FP16 or a Cheap Quantized Stand-In
**Tags:** #ai-inference #gpu-cloud #ai-compute #arweave #decentralized-storage #decentralize-ai-hackathon (+ 2nd post: #on-demand-gpus #developer-tools)
**TL;DR (≤ 3 lines):** I ran TBD jobs on TBD Nosana nodes. TBD% matched the FP16 fingerprint exactly, TBD drifted, TBD looked substituted. Every receipt is on Arweave: TBD manifest IDs.

1. **The question nobody measures** — "decentralizable trust" is argued (cite hackernoon.com/decentralized-ai-needs-decentralizable-trust-not-just-decentralized-compute, hackernoon.com/open-inference-needs-more-than-open-weights), not measured. Hook: a stranger's GPU, a model you can't see.
2. **Why substitution is tempting** — VRAM/cost of FP16 vs AWQ vs Q4 for Llama 3.1 8B (TBD GB, TBD tok/s from calibration).
3. **Method** — 200 pinned prompts (sha256 c0ce9e12…), temp 0, top-5 logprobs, pinned probe fetched by commit sha; receipts in logs → IPFS → Arweave. Diagram.
4. **Calibration: what each quantization's fingerprint looks like** — matrix chart (results/charts/calibration_matrix.png), TBD |Δlogprob| fp16↔awq, fp16↔q4, same-variant cross-GPU jitter TBD. Classifier leave-one-out accuracy: TBD.
5. **The audit** — TBD jobs, TBD markets, GPU types table (from nvidia-smi). Chart: exact_match.png. Verdict counts: OK TBD / DRIFT TBD / SUBSTITUTED TBD.
6. **Surprises** — TBD (e.g., cross-GPU nondeterminism magnitude, cold-start time, driver versions seen).
7. **Cost** — total credits used TBD; $ per verified run TBD; time to first receipt TBD.
8. **Verify me** — `node arweave/fetch.mjs <txid>` and the list of TBD manifest IDs; repo link https://github.com/ahmardchain/momo.
9. **Limits & what would make this proof** — no TEE/zkML, honest-but-nondeterministic hardware, how a cheater could evade (serve FP16 only for known prompt sets → rotate secret prompts), next steps.
10. **Takeaway for builders** — a 1-command spot-check any Nosana user can run.

Rule for drafting: no number goes in unless it comes from results/report.json or an Arweave receipt. Never use synthetic chart images.
