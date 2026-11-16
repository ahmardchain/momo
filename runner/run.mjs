// Momo runner: post N one-shot jobs across GPU markets with Nosana credits, collect receipts.
// Docs: https://learn.nosana.com/api/first-job.html (validate -> ipfs.pin -> jobs.list -> poll ipfsResult)
//
// Credit-paid jobs must use a timeout of at least 3600 seconds or the API returns 400.
// --max-credits is a USD ceiling. Without --yes this prints the worst-case cost and exits.
//
// Usage:
//   NOSANA_API_KEY=nos_... node runner/run.mjs --list-markets
//   NOSANA_API_KEY=nos_... node runner/run.mjs --variant fp16 --markets <addr,...> --per-market 4 --max-credits 40 --timeout-s 3600
//   NOSANA_API_KEY=nos_... node runner/run.mjs --variant fp16 --markets <addr,...> --per-market 4 --max-credits 40 --timeout-s 3600 --yes
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createNosanaClient, NosanaNetwork, validateJobDefinition } from '@nosana/kit';
import { decodeReceipt } from './decode.mjs';
import { planSpend, submitSequentially, formatPlan, balanceToUsd, usdPerHour } from './budget.mjs';
import { verifyPins } from './job_pin.mjs';

const a = process.argv.slice(2);
const opt = (f, d) => (a.includes(f) ? a[a.indexOf(f) + 1] : d);
const has = (f) => a.includes(f);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPinnedFile(commit, name) {
  const rel = name === 'probe.py' ? 'probe/probe.py' : name === 'prompts.json' ? 'probe/prompts.json' : null;
  if (!rel) return null;
  const r = spawnSync('git', ['show', `${commit}:${rel}`], { cwd: ROOT });
  if (r.status !== 0) return null;
  return r.stdout;
}

async function listWithSameKey(client, body, key) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await client.api.jobs.list(body, { idempotencyKey: key });
    } catch (e) {
      last = e;
      const status = e?.status ?? e?.statusCode ?? e?.response?.status;
      // 4xx other than 409 is a real rejection. A new key would not make it succeed,
      // and a new key after a lost response can list a second job.
      if (status && status >= 400 && status < 500 && status !== 409) throw e;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw last;
}

if (!process.env.NOSANA_API_KEY) {
  console.error('Set NOSANA_API_KEY (dashboard: deploy.nosana.com -> API keys)');
  process.exit(1);
}
const client = createNosanaClient(NosanaNetwork.MAINNET, { api: { apiKey: process.env.NOSANA_API_KEY } });

if (has('--list-markets')) {
  for (const m of await client.api.markets.list()) {
    console.log(JSON.stringify({
      name: m.name, address: m.address, vram: m.vram, type: m.type,
      usd_per_hour: usdPerHour(m),
    }));
  }
  process.exit(0);
}

const variant = opt('--variant', 'fp16');
const markets = (opt('--markets', '') || '').split(',').filter(Boolean);
const per = Number(opt('--per-market', 1));
const timeout = Number(opt('--timeout-s', 3600));
const maxCredits = Number(opt('--max-credits', 30));
if (!markets.length) {
  console.error('--markets required (see --list-markets)');
  process.exit(1);
}
const jdPath = path.join(ROOT, `nosana/generated/job-${variant}.json`);
if (!fs.existsSync(jdPath)) {
  console.error(`No job file at ${jdPath}. Build it with python3 nosana/build_jobs.py --commit $(git rev-parse HEAD)`);
  process.exit(1);
}
const jd = JSON.parse(fs.readFileSync(jdPath));
const pin = verifyPins(jd, readPinnedFile);
if (!pin.ok) {
  console.error(pin.error);
  process.exit(1);
}
const v = validateJobDefinition(jd);
if (!v.success) {
  console.error(v.errors);
  process.exit(1);
}

const listed = await client.api.markets.list();
const usdPerHourByMarket = {};
for (const m of listed) {
  if (m.address) usdPerHourByMarket[m.address] = usdPerHour(m);
}
const bal = await client.api.credits.balance();
const avail = balanceToUsd(bal);
const plan = planSpend({
  markets,
  perMarket: per,
  timeoutS: timeout,
  maxCreditsUsd: maxCredits,
  availableUsd: avail?.usd,
  usdPerHourByMarket,
});
const requestedJobs = markets.length * per;
console.log(formatPlan({
  variant,
  commit: pin.commit,
  requestedJobs,
  plan,
  timeoutS: timeout,
  maxCreditsUsd: maxCredits,
  availableUsd: avail?.usd,
  availableCents: avail?.cents,
  yes: has('--yes'),
}));
console.log(JSON.stringify({
  variant, commit: pin.commit, markets, per_market: per, timeout_s: timeout,
  max_credits_usd: maxCredits,
  available_usd: avail?.usd ?? null,
  available_cents: avail?.cents ?? null,
  jobs_that_fit: plan.ok ? plan.jobs.length : 0,
  worst_case_usd_per_job: plan.eachUsd ?? null,
  worst_case_total_usd: plan.ok ? plan.totalUsd : null,
}));
if (!plan.ok) process.exit(1);
if (!has('--yes')) process.exit(0);
if (plan.jobs.length === 0) {
  console.error(plan.stopReason || 'Nothing fits in the budget. No jobs posted.');
  process.exit(2);
}

const ipfsHash = await client.ipfs.pin(v.data);
const outDir = path.join(ROOT, 'data/nodes');
fs.mkdirSync(outDir, { recursive: true });
const log = path.join(ROOT, 'data/jobs.jsonl');
const inflight = new Set();
let stopping = false;
async function stopInflight() {
  if (stopping) return;
  stopping = true;
  for (const id of inflight) {
    await client.api.jobs.stop(id).catch(() => {});
  }
}
process.once('SIGINT', () => {
  console.error('\nStopping posted jobs so they do not run out the timeout...');
  stopInflight().finally(() => process.exit(130));
});
process.once('SIGTERM', () => {
  stopInflight().finally(() => process.exit(143));
});

const { posted, spent, stopReason } = await submitSequentially({
  jobs: plan.jobs,
  maxCreditsUsd: maxCredits,
  availableUsd: avail.usd,
  post: async (job) => {
    const key = crypto.randomUUID();
    fs.appendFileSync(log, JSON.stringify({
      state: 'posting', idempotency_key: key, market: job.market, variant,
      usd_estimate: job.usd, at: new Date().toISOString(),
    }) + '\n');
    const p = await listWithSameKey(client, { ipfsHash, market: job.market, timeout }, key);
    if (!p?.job) throw new Error('Nosana returned no job id. Not posting further jobs.');
    fs.appendFileSync(log, JSON.stringify({
      state: 'posted', idempotency_key: key, job: p.job, market: job.market, variant,
      ipfsHash, credits: p.credits, usd_estimate: job.usd, posted_at: new Date().toISOString(),
    }) + '\n');
    inflight.add(p.job);
    console.log('posted', p.job, job.market, `worst-case $${job.usd.toFixed(4)}`);
    return p;
  },
});
if (stopReason) console.warn(stopReason);
console.log(`posted ${posted.length} job(s); worst-case reserved $${spent.toFixed(4)} of $${maxCredits} USD`);

for (const rec of posted) {
  const jobId = rec.response.job;
  let job = await client.api.jobs.get(jobId);
  const t0 = Date.now();
  while (!job.ipfsResult && Date.now() - t0 < (timeout + 900) * 1000) {
    await new Promise((r) => setTimeout(r, 15000));
    job = await client.api.jobs.get(jobId);
    process.stdout.write(`\r${jobId} ${job.state}   `);
  }
  if (!job.ipfsResult) {
    console.log(`\n${jobId}: no result, stopping job`);
    await client.api.jobs.stop(jobId).catch(() => {});
    inflight.delete(jobId);
    continue;
  }
  const results = await client.ipfs.retrieve(job.ipfsResult);
  fs.writeFileSync(path.join(ROOT, `data/raw-${jobId}.json`), JSON.stringify(results));
  try {
    const r = decodeReceipt(JSON.stringify(results));
    r.nosana = { job: jobId, market: rec.job.market, node: job.node, ipfsResult: job.ipfsResult, ipfsJob: ipfsHash };
    fs.writeFileSync(path.join(outDir, `${variant}-${jobId}.json`), JSON.stringify(r));
    console.log(`\n${jobId}: receipt saved (${r.gpu?.rows?.[0]})`);
  } catch (e) {
    console.log(`\n${jobId}: could not decode receipt: ${e.message} (raw saved)`);
  }
  inflight.delete(jobId);
}
