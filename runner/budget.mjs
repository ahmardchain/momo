// Budget gate for Nosana credit-paid jobs.
//
// --max-credits is a USD ceiling (the $70 hackathon pot is dollars).
// A live balance was { assignedCredits: 70, reservedCredits: 0, settledCredits: 0 }
// while the dashboard showed $70.00 and the only transaction was amountUsd: 70.
// Those fields are USD, even though the OpenAPI text says cents. Dividing by 100
// reported $0.70 and stopped the audit after a handful of jobs.
// jobs.list may still return creditsUsed in cents; that quote is ignored unless
// it lands near the price-based estimate. A quote is often 0 at post time, so
// the gate uses worst-case price (USD/hour × timeout) and never treats a
// missing or zero quote as free.

export const MIN_TIMEOUT_S = 3600;
export const CENTS_PER_USD = 100;

export function usdPerHour(market) {
  if (!market || typeof market !== 'object') return null;
  const raw = market.usd_reward_per_hour ?? market.price;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function transactionList(transactions) {
  if (Array.isArray(transactions)) return transactions;
  if (!transactions || typeof transactions !== 'object') return null;
  for (const key of ['transactions', 'items', 'data', 'results']) {
    if (Array.isArray(transactions[key])) return transactions[key];
  }
  return null;
}

/** Sum of transaction amountUsd, or null when there is nothing to compare. */
export function transactionUsdSum(transactions) {
  const list = transactionList(transactions);
  if (!list) return null;
  let sum = 0;
  let any = false;
  for (const tx of list) {
    const n = Number(tx?.amountUsd);
    if (!Number.isFinite(n)) continue;
    sum += n;
    any = true;
  }
  return any ? sum : null;
}

function offByAbout100(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  return (ratio >= 50 && ratio <= 200) || (ratio >= 1 / 200 && ratio <= 1 / 50);
}

/**
 * Available credit balance in USD.
 * assigned/reserved/settled are dollars: available = assigned - reserved - settled.
 * Returns null when the balance is missing or not a finite number (caller must refuse).
 * If that available amount and the sum of transaction amountUsd differ by about 100×,
 * one side is the cents figure from the OpenAPI text. Prefer the dollar reading
 * (the magnitude that matches a $70 dashboard balance, not 100× that) and warn.
 */
export function balanceToUsd(balance, transactions) {
  if (!balance || typeof balance !== 'object') return null;
  const assigned = Number(balance.assignedCredits);
  const reserved = Number(balance.reservedCredits);
  const settled = Number(balance.settledCredits);
  if (![assigned, reserved, settled].every((n) => Number.isFinite(n))) return null;
  const available = assigned - reserved - settled;
  if (!Number.isFinite(available)) return null;

  const txSum = transactionUsdSum(transactions);
  if (txSum == null) return { usd: available, warning: null };
  if (available === 0 && txSum === 0) return { usd: 0, warning: null };

  const ratio = txSum === 0 ? Infinity : Math.abs(available / txSum);
  if (!offByAbout100(ratio)) return { usd: available, warning: null };

  // The dollar number is the smaller magnitude. 7000 vs amountUsd 70 → $70.
  // 70 vs amountUsd 7000 → $70. Never keep the 100× (cents) reading.
  const usd = Math.abs(available) <= Math.abs(txSum) ? available : available / CENTS_PER_USD;
  const warning = `Credit balance ${available} and the sum of transaction amountUsd (${txSum}) differ by about 100×. ` +
    `Using $${usd} USD. A live balance of 70 is the dashboard $70.00, so these fields are dollars; ` +
    `a 100× gap is the cents/dollars mix in the OpenAPI text.`;
  console.warn(warning);
  return { usd, warning };
}

export function worstCaseUsd(usdPerHourRate, timeoutS) {
  if (!Number.isFinite(usdPerHourRate) || usdPerHourRate <= 0) return null;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) return null;
  return usdPerHourRate * (timeoutS / 3600);
}

/**
 * How many jobs fit before the next one would exceed the USD budget or the
 * available balance. Returns ok:false (post nothing) when price, timeout, or
 * balance is missing — fail closed.
 */
export function planSpend({ markets, perMarket, timeoutS, maxCreditsUsd, availableUsd, usdPerHourByMarket }) {
  const empty = { jobs: [], totalUsd: 0, capped: false };
  if (!Number.isFinite(maxCreditsUsd) || maxCreditsUsd < 0) {
    return { ...empty, ok: false, error: '--max-credits must be a USD amount >= 0 (for example 40 for a $40 ceiling).' };
  }
  if (!Number.isFinite(timeoutS) || timeoutS < MIN_TIMEOUT_S) {
    return {
      ...empty, ok: false,
      error: `timeout ${timeoutS}s is below Nosana's ${MIN_TIMEOUT_S}s minimum for credit-paid jobs. ` +
        'A shorter timeout is rejected with HTTP 400. Pass --timeout-s 3600 or higher.',
    };
  }
  if (!Number.isFinite(availableUsd)) {
    return { ...empty, ok: false, error: 'Credit balance is missing or not a number. Refusing to post (fail closed).' };
  }
  if (availableUsd < 0) {
    return { ...empty, ok: false, error: `Available balance is $${availableUsd.toFixed(2)}. Refusing to post.` };
  }
  if (!Array.isArray(markets) || markets.length === 0) {
    return { ...empty, ok: false, error: 'No markets to post to.' };
  }
  if (!Number.isInteger(perMarket) || perMarket < 1) {
    return { ...empty, ok: false, error: '--per-market must be a positive integer.' };
  }
  const jobs = [];
  let spent = 0;
  let eachUsd = null;
  for (const market of markets) {
    const rate = usdPerHourByMarket ? usdPerHourByMarket[market] : null;
    const each = worstCaseUsd(rate, timeoutS);
    if (each == null) {
      return {
        ...empty, ok: false,
        error: `No positive USD/hour price for market ${market}. Refusing to post (fail closed).`,
      };
    }
    eachUsd = each;
    for (let i = 0; i < perMarket; i++) {
      if (spent + each > maxCreditsUsd + 1e-9) {
        return {
          ok: true, jobs, totalUsd: spent, eachUsd, capped: true,
          stopReason: `next job worst-case $${each.toFixed(4)} would exceed --max-credits $${maxCreditsUsd} ` +
            `(already reserved $${spent.toFixed(4)})`,
        };
      }
      if (spent + each > availableUsd + 1e-9) {
        return {
          ok: true, jobs, totalUsd: spent, eachUsd, capped: true,
          stopReason: `next job worst-case $${each.toFixed(4)} would exceed available balance $${availableUsd.toFixed(2)} ` +
            `(already reserved $${spent.toFixed(4)})`,
        };
      }
      jobs.push({ market, i, usd: each });
      spent += each;
    }
  }
  return { ok: true, jobs, totalUsd: spent, eachUsd, capped: false, stopReason: null };
}

/**
 * Dollars to add to the spend counter after a post.
 * Never returns less than the pre-job estimate: a missing quote or creditsUsed
 * of 0 must not make the next job look free.
 * costUSD is dollars. creditsUsed is only counted when creditsUsed/100 lands
 * near the price estimate (the job-quote unit is not the balance unit). A figure
 * that is not near the estimate is ignored so a unit mix cannot zero the counter
 * or inflate it 100×.
 */
export function accountJobUsd(credits, estimateUsd) {
  const est = Number(estimateUsd);
  if (!Number.isFinite(est) || est <= 0) return null;
  const cost = Number(credits?.costUSD);
  const used = Number(credits?.creditsUsed);
  const candidates = [];
  if (Number.isFinite(cost) && cost > 0) candidates.push(cost);
  if (Number.isFinite(used) && used > 0) candidates.push(used / CENTS_PER_USD);
  const near = candidates.filter((c) => c >= est * 0.5 && c <= est * 5);
  const quoted = near.length ? Math.max(...near) : est;
  return Math.max(est, quoted);
}

/**
 * Post only while the next worst-case still fits. `post` is called only for
 * jobs that fit. A zero creditsUsed response still consumes `job.usd`.
 */
export async function submitSequentially({ jobs, maxCreditsUsd, availableUsd, post }) {
  const posted = [];
  let spent = 0;
  let stopReason = null;
  for (const job of jobs) {
    const est = Number(job.usd);
    if (!Number.isFinite(est) || est <= 0) {
      stopReason = 'Job has no positive USD estimate. Refusing to post (fail closed).';
      break;
    }
    if (spent + est > maxCreditsUsd + 1e-9) {
      stopReason = `next job worst-case $${est.toFixed(4)} would exceed --max-credits $${maxCreditsUsd} (spent $${spent.toFixed(4)})`;
      break;
    }
    if (spent + est > availableUsd + 1e-9) {
      stopReason = `next job worst-case $${est.toFixed(4)} would exceed available balance $${availableUsd.toFixed(2)} (spent $${spent.toFixed(4)})`;
      break;
    }
    let res;
    try {
      res = await post(job);
    } catch (e) {
      stopReason = `Post failed (${e.message || e}). Not submitting further jobs.`;
      break;
    }
    const charged = accountJobUsd(res?.credits, est);
    posted.push({ job, usd: charged ?? est, response: res });
    spent += charged ?? est;
    if (charged == null) {
      stopReason = 'Cost quote missing after post. Stopping so later jobs are not submitted (fail closed).';
      break;
    }
  }
  return { posted, spent, stopReason };
}

export function formatPlan({ variant, requestedJobs, plan, timeoutS, maxCreditsUsd, availableUsd, balanceWarning, yes, commit }) {
  const lines = [];
  if (!plan.ok) {
    lines.push('REFUSING TO POST — budget check failed closed. No jobs submitted.');
    lines.push(plan.error);
    return lines.join('\n');
  }
  lines.push(yes
    ? 'SPEND CHECK — posting only the jobs below. Worst case is the full timeout at the market hourly price.'
    : 'DRY RUN — no Nosana jobs will be posted and no credits will be spent.');
  lines.push(`variant: ${variant}`);
  if (commit) lines.push(`pinned commit: ${commit}`);
  lines.push(`timeout: ${timeoutS}s (credit-paid minimum ${MIN_TIMEOUT_S}s; billed for actual runtime, reserved here at the full timeout)`);
  lines.push(`requested jobs: ${requestedJobs}`);
  lines.push(`jobs that fit: ${plan.jobs.length}`);
  const prices = [...new Set(plan.jobs.map((j) => j.usd))];
  if (prices.length === 1) lines.push(`worst-case USD per job: $${prices[0].toFixed(4)}`);
  else if (prices.length > 1) lines.push(`worst-case USD per job: $${Math.min(...prices).toFixed(4)}–$${Math.max(...prices).toFixed(4)} depending on market`);
  else if (plan.eachUsd != null) lines.push(`worst-case USD per job: $${plan.eachUsd.toFixed(4)}`);
  lines.push(`worst-case total: $${plan.totalUsd.toFixed(4)}`);
  lines.push(`budget --max-credits: $${Number(maxCreditsUsd).toFixed(2)} USD`);
  lines.push(`available balance: $${Number(availableUsd).toFixed(2)} USD`);
  if (balanceWarning) lines.push(`warning: ${balanceWarning}`);
  if (plan.stopReason) lines.push(`stopped early: ${plan.stopReason}`);
  if (!yes) {
    lines.push(plan.jobs.length
      ? 'Re-run the same command with --yes to post the jobs that fit.'
      : 'Nothing fits in the budget. No jobs will be posted.');
  }
  return lines.join('\n');
}
