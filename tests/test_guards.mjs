import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planSpend, submitSequentially, accountJobUsd, balanceToUsd, formatPlan } from '../runner/budget.mjs';
import { extractPins, verifyPins } from '../runner/job_pin.mjs';
import { pack, restoreGzipChunks, uploadBuffers, FREE_ITEM_BYTES, DATA_ITEM_OVERHEAD_BYTES } from '../arweave/upload.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('USD budget stops submission across markets when creditsUsed would stay 0', async () => {
  const plan = planSpend({
    markets: ['m1', 'm2', 'm3'],
    perMarket: 4,
    timeoutS: 3600,
    maxCreditsUsd: 1,
    availableUsd: 70,
    usdPerHourByMarket: { m1: 0.48, m2: 0.48, m3: 0.48 },
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.jobs.map((j) => j.market), ['m1', 'm1']);
  assert.ok(plan.totalUsd <= 1);
  assert.equal(plan.capped, true);

  const calls = [];
  const live = await submitSequentially({
    jobs: plan.jobs.concat([
      { market: 'm2', i: 0, usd: 0.48 },
      { market: 'm3', i: 0, usd: 0.48 },
    ]),
    maxCreditsUsd: 1,
    availableUsd: 70,
    post: async (job) => {
      calls.push(job.market);
      return { job: 'job-' + calls.length, credits: { creditsUsed: 0, costUSD: 0 } };
    },
  });
  assert.deepEqual(calls, ['m1', 'm1']);
  assert.equal(live.posted.length, 2);
  assert.ok(live.spent <= 1 + 1e-9);
  assert.match(live.stopReason, /max-credits/);
});

test('$40 cap is dollars, so a 12-job audit at $0.48/h still fits', () => {
  const balance = balanceToUsd({ assignedCredits: 70, reservedCredits: 0, settledCredits: 0 });
  assert.equal(balance.usd, 70);
  const plan = planSpend({
    markets: ['a', 'b', 'c'],
    perMarket: 4,
    timeoutS: 3600,
    maxCreditsUsd: 40,
    availableUsd: balance.usd,
    usdPerHourByMarket: { a: 0.48, b: 0.48, c: 0.48 },
  });
  assert.equal(plan.jobs.length, 12);
  assert.ok(plan.totalUsd < 40);
  const text = formatPlan({
    variant: 'fp16', requestedJobs: 12, plan, timeoutS: 3600,
    maxCreditsUsd: 40, availableUsd: balance.usd, yes: false,
  });
  assert.match(text, /DRY RUN/);
  assert.match(text, /no credits will be spent/);
  assert.match(text, /\$40\.00 USD/);
  assert.match(text, /available balance: \$70\.00 USD/);
  assert.doesNotMatch(text, /cents/);
  assert.match(text, /worst-case USD per job: \$0\.4800/);
});

test('available balance subtracts reserved and settled, in dollars', () => {
  const balance = balanceToUsd({ assignedCredits: 70, reservedCredits: 12.5, settledCredits: 7.5 });
  assert.equal(balance.usd, 50);
  assert.equal(balance.warning, null);
});

test('a 100× gap with the ledger keeps the dollar reading and warns', () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const centsLooking = balanceToUsd(
      { assignedCredits: 7000, reservedCredits: 0, settledCredits: 0 },
      [{ type: 'invitation_claim', amountUsd: 70 }],
    );
    assert.equal(centsLooking.usd, 70);
    const dollarsLooking = balanceToUsd(
      { assignedCredits: 70, reservedCredits: 0, settledCredits: 0 },
      [{ type: 'invitation_claim', amountUsd: 7000 }],
    );
    assert.equal(dollarsLooking.usd, 70);
    const agreed = balanceToUsd(
      { assignedCredits: 70, reservedCredits: 0, settledCredits: 0 },
      [{ type: 'invitation_claim', amountUsd: 70 }],
    );
    assert.equal(agreed.usd, 70);
    assert.equal(agreed.warning, null);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /100/);
  assert.equal(balanceToUsd(null), null);
  assert.equal(balanceToUsd({ assignedCredits: Number.NaN, reservedCredits: 0, settledCredits: 0 }), null);
  assert.equal(balanceToUsd({ assignedCredits: 'nope', reservedCredits: 0, settledCredits: 0 }), null);
  const refused = planSpend({
    markets: ['a'], perMarket: 4, timeoutS: 3600, maxCreditsUsd: 40,
    availableUsd: balanceToUsd({ assignedCredits: 'nope', reservedCredits: 0, settledCredits: 0 })?.usd,
    usdPerHourByMarket: { a: 0.48 },
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.jobs.length, 0);
});

test('missing price, short timeout, and missing balance post nothing', () => {
  const noPrice = planSpend({
    markets: ['m'], perMarket: 3, timeoutS: 3600, maxCreditsUsd: 40, availableUsd: 70,
    usdPerHourByMarket: {},
  });
  assert.equal(noPrice.ok, false);
  assert.equal(noPrice.jobs.length, 0);
  assert.match(noPrice.error, /Refusing to post/);

  const short = planSpend({
    markets: ['m'], perMarket: 3, timeoutS: 2400, maxCreditsUsd: 40, availableUsd: 70,
    usdPerHourByMarket: { m: 0.48 },
  });
  assert.equal(short.ok, false);
  assert.equal(short.jobs.length, 0);
  assert.match(short.error, /3600/);

  const noBal = planSpend({
    markets: ['m'], perMarket: 1, timeoutS: 3600, maxCreditsUsd: 40, availableUsd: Number.NaN,
    usdPerHourByMarket: { m: 0.48 },
  });
  assert.equal(noBal.ok, false);
  assert.equal(noBal.jobs.length, 0);
});

test('available balance stops posting even when the dollar cap is higher', () => {
  const plan = planSpend({
    markets: ['a', 'b'], perMarket: 4, timeoutS: 3600, maxCreditsUsd: 40, availableUsd: 0.5,
    usdPerHourByMarket: { a: 0.48, b: 0.48 },
  });
  assert.equal(plan.jobs.length, 1);
  assert.match(plan.stopReason, /available balance/);
});

test('a zero creditsUsed quote cannot shrink the reserved amount', () => {
  assert.equal(accountJobUsd({ creditsUsed: 0, costUSD: 0 }, 0.48), 0.48);
  assert.equal(accountJobUsd(undefined, 0.48), 0.48);
  assert.equal(accountJobUsd({ costUSD: 0.48, creditsUsed: 48 }, 0.48), 0.48);
  assert.equal(accountJobUsd({ costUSD: 0.9, creditsUsed: 90 }, 0.48), 0.9);
});

test('a higher in-range quote stops later jobs', async () => {
  const calls = [];
  const live = await submitSequentially({
    jobs: [
      { market: 'a', usd: 0.4 },
      { market: 'a', usd: 0.4 },
      { market: 'a', usd: 0.4 },
    ],
    maxCreditsUsd: 1,
    availableUsd: 70,
    post: async (job) => {
      calls.push(job);
      return { credits: { costUSD: 0.7, creditsUsed: 70 } };
    },
  });
  // Estimate-only, two $0.40 jobs would fit in $1. The $0.70 quote fills the cap after one.
  assert.equal(calls.length, 1);
  assert.equal(live.spent, 0.7);
  assert.match(live.stopReason, /max-credits/);
});

test('fake commit pinned by a test build is refused before any post', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-jobs-'));
  const tracked = path.join(ROOT, 'nosana/generated/job-fp16.json');
  const before = fs.readFileSync(tracked);
  execFileSync('python3', ['nosana/build_jobs.py', '--commit', 'abc123', '--out', dir], { cwd: ROOT });
  assert.deepEqual(fs.readFileSync(tracked), before);
  const jd = JSON.parse(fs.readFileSync(path.join(dir, 'job-fp16.json'), 'utf8'));
  const pins = extractPins(jd);
  assert.equal(pins.ok, false);
  assert.match(pins.error, /abc123/);
  assert.match(pins.error, /Refusing to post/);
});

test('checked-in fp16 job matches the commit it names', () => {
  const jd = JSON.parse(fs.readFileSync(path.join(ROOT, 'nosana/generated/job-fp16.json'), 'utf8'));
  const pins = verifyPins(jd, (commit, name) => {
    const rel = name === 'probe.py' ? 'probe/probe.py' : 'probe/prompts.json';
    return execFileSync('git', ['show', `${commit}:${rel}`], { cwd: ROOT });
  });
  assert.equal(pins.ok, true);
  assert.equal(pins.commit.length, 40);
  const mismatch = verifyPins(jd, () => Buffer.from('not the probe'));
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /sha256/);
  assert.match(mismatch.error, /Refusing to post|sha mismatch/);
});

test('oversized receipts are split under the free tier and re-check by sha256', () => {
  const raw = crypto.randomBytes(500_000);
  const packed = pack(raw);
  assert.ok(packed.chunks.length > 1);
  const maxPayload = FREE_ITEM_BYTES - DATA_ITEM_OVERHEAD_BYTES;
  for (const chunk of packed.chunks) {
    assert.ok(chunk.byteLength <= maxPayload);
    assert.ok(chunk.byteLength + DATA_ITEM_OVERHEAD_BYTES <= FREE_ITEM_BYTES);
    assert.equal(chunk.byteOffset, 0);
    assert.equal(chunk.buffer.byteLength, chunk.byteLength);
  }
  const restored = restoreGzipChunks(packed.chunks);
  assert.deepEqual(restored, raw);
  assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), packed.sha256);
});

test('an item that cannot fit the free tier never calls upload', async () => {
  let calls = 0;
  await assert.rejects(
    () => uploadBuffers([{ name: 'receipt.json', raw: crypto.randomBytes(2000) }], {
      upload: async () => { calls += 1; return { id: 'x', winc: '0' }; },
      freeItemBytes: 100,
      overhead: 4096,
    }),
    (err) => {
      assert.match(err.message, /Refusing paid Arweave upload/);
      assert.match(err.message, /free tier|105 KiB|paid upload/);
      return true;
    },
  );
  assert.equal(calls, 0);
});

test('a charged chunk aborts the rest of the upload', async () => {
  let calls = 0;
  await assert.rejects(
    () => uploadBuffers([{ name: 'receipt.json', raw: crypto.randomBytes(400_000) }], {
      upload: async () => {
        calls += 1;
        return { id: 'tx' + calls, winc: '12' };
      },
    }),
    /charged 12 winc/,
  );
  assert.equal(calls, 1);
});

test('exhausted free allowance uploads nothing', async () => {
  let calls = 0;
  await assert.rejects(
    () => uploadBuffers([{ name: 'receipt.json', raw: Buffer.from('{"schema":"momo/receipt/v1"}') }], {
      upload: async () => { calls += 1; return { id: 'x', winc: '0' }; },
      bytesRemaining: 10,
    }),
    /Refusing paid Arweave upload/,
  );
  assert.equal(calls, 0);
});
