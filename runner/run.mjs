// Momo runner: post N one-shot jobs across GPU markets with Nosana credits, collect receipts from results/logs.
// Docs: https://learn.nosana.com/api/first-job.html (validate -> ipfs.pin -> api.jobs.list -> poll ipfsResult)
//
// Usage:
//   NOSANA_API_KEY=nos_... node runner/run.mjs --list-markets
//   NOSANA_API_KEY=nos_... node runner/run.mjs --variant fp16 --markets <addr1,addr2,...> --per-market 2 [--timeout-s 2400] [--max-credits 30] [--yes]
// Without --yes it prints the plan + estimated cost and exits (nothing is spent).
import fs from 'node:fs'; import path from 'node:path';
import { createNosanaClient, NosanaNetwork, validateJobDefinition } from '@nosana/kit';
import { decodeReceipt } from './decode.mjs';
const a = process.argv.slice(2); const opt = (f, d) => (a.includes(f) ? a[a.indexOf(f) + 1] : d); const has = (f) => a.includes(f);
if (!process.env.NOSANA_API_KEY) { console.error('Set NOSANA_API_KEY (dashboard: deploy.nosana.com -> API keys)'); process.exit(1); }
const client = createNosanaClient(NosanaNetwork.MAINNET, { api: { apiKey: process.env.NOSANA_API_KEY } });
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

if (has('--list-markets')) {
  for (const m of await client.api.markets.list()) console.log(JSON.stringify({ name: m.name, address: m.address, vram: m.vram, type: m.type, price: m.usd_reward_per_hour ?? m.price }));
  process.exit(0);
}
const variant = opt('--variant', 'fp16');
const markets = (opt('--markets', '') || '').split(',').filter(Boolean);
const per = Number(opt('--per-market', 1)); const timeout = Number(opt('--timeout-s', 2400)); const maxCredits = Number(opt('--max-credits', 30));
if (!markets.length) { console.error('--markets required (see --list-markets)'); process.exit(1); }
const jd = JSON.parse(fs.readFileSync(path.join(ROOT, `nosana/generated/job-${variant}.json`)));
if (JSON.stringify(jd).includes('PLACEHOLDER')) { console.error('Rebuild jobs with the pushed commit: python3 nosana/build_jobs.py --commit $(git rev-parse HEAD)'); process.exit(1); }
const v = validateJobDefinition(jd);
if (!v.success) { console.error(v.errors); process.exit(1); }
const bal = await client.api.credits.balance();
const avail = bal.assignedCredits - bal.reservedCredits - bal.settledCredits;
console.log({ variant, markets, per_market: per, jobs: markets.length * per, timeout_s: timeout, available_credits: avail, max_credits: maxCredits });
if (!has('--yes')) { console.log('Dry plan only. Re-run with --yes to post jobs.'); process.exit(0); }
const ipfsHash = await client.ipfs.pin(v.data);
const outDir = path.join(ROOT, 'data/nodes'); fs.mkdirSync(outDir, { recursive: true });
const log = path.join(ROOT, 'data/jobs.jsonl'); let spent = 0; const posted = [];
for (const market of markets) for (let i = 0; i < per; i++) {
  if (spent >= maxCredits) { console.warn('max-credits reached, stopping'); break; }
  const p = await client.api.jobs.list({ ipfsHash, market, timeout });
  spent += Number(p.credits?.creditsUsed ?? 0);
  const rec = { job: p.job, market, variant, ipfsHash, credits: p.credits, posted_at: new Date().toISOString() };
  fs.appendFileSync(log, JSON.stringify(rec) + '\n'); posted.push(rec); console.log('posted', rec.job, market);
}
for (const rec of posted) {
  let job = await client.api.jobs.get(rec.job); const t0 = Date.now();
  while (!job.ipfsResult && Date.now() - t0 < (timeout + 900) * 1000) {
    await new Promise((r) => setTimeout(r, 15000)); job = await client.api.jobs.get(rec.job); process.stdout.write(`\r${rec.job} ${job.state}   `);
  }
  if (!job.ipfsResult) { console.log(`\n${rec.job}: no result, stopping job`); await client.api.jobs.stop(rec.job).catch(() => {}); continue; }
  const results = await client.ipfs.retrieve(job.ipfsResult);
  fs.writeFileSync(path.join(ROOT, `data/raw-${rec.job}.json`), JSON.stringify(results));
  try {
    const r = decodeReceipt(JSON.stringify(results));
    r.nosana = { job: rec.job, market: rec.market, node: job.node, ipfsResult: job.ipfsResult, ipfsJob: rec.ipfsHash };
    fs.writeFileSync(path.join(outDir, `${variant}-${rec.job}.json`), JSON.stringify(r));
    console.log(`\n${rec.job}: receipt saved (${r.gpu?.rows?.[0]})`);
  } catch (e) { console.log(`\n${rec.job}: could not decode receipt: ${e.message} (raw saved)`); }
}
