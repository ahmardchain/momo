// Momo: upload receipts to Arweave via ar.io Turbo.
// Free tier (mainnet): each data item <= 105 KiB is free, within 10 MiB lifetime
// per wallet and per IP — https://docs.ar.io/build/upload/upload-and-verify/
// Receipts are gzipped and split so every signed item stays under that limit.
// A chunk that would not be free is a hard error. This process never continues
// into a paid upload.
//
// Usage:
//   node arweave/upload.mjs <receipt.json|dir> [--wallet ~/.momo/arweave-wallet.json] [--sandbox] [--dry-run]
// Wallet: an Arweave JWK (generate offline: `node arweave/upload.mjs --gen-wallet ~/.momo/arweave-wallet.json`).
// Writes arweave/uploads.jsonl with {file, sha256, manifest_txid, chunk_txids}.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const FREE_ITEM_BYTES = 105 * 1024;
// ANS-104 signature, owner, and tags. Kept larger than the real header so a
// max-sized chunk plus its tags cannot cross 105 KiB.
export const DATA_ITEM_OVERHEAD_BYTES = 8 * 1024;

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function pack(buf, chunkBytes = FREE_ITEM_BYTES - DATA_ITEM_OVERHEAD_BYTES) {
  if (!Number.isFinite(chunkBytes) || chunkBytes < 1) {
    throw new Error(`Refusing paid Arweave upload: chunk size ${chunkBytes} is not a positive number of bytes.`);
  }
  const gz = zlib.gzipSync(buf, { level: 9 });
  const chunks = [];
  for (let i = 0; i < gz.length; i += chunkBytes) {
    // Own the bytes. subarray() views the whole gzip, and Buffer.from() of a
    // small slice still sits in Node's 8 KiB pool, so `.buffer` is larger than
    // the chunk. An uploader that reads the underlying ArrayBuffer would then
    // post extra bytes and cross the free-tier line.
    const view = gz.subarray(i, i + chunkBytes);
    const copy = Buffer.allocUnsafeSlow(view.length);
    view.copy(copy);
    chunks.push(copy);
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  return { gz, chunks, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

export function restoreGzipChunks(chunks) {
  return zlib.gunzipSync(Buffer.concat(chunks));
}

export function guardChunk(payloadBytes, { freeItemBytes = FREE_ITEM_BYTES, overhead = DATA_ITEM_OVERHEAD_BYTES, label = 'item' } = {}) {
  const item = payloadBytes + overhead;
  if (item > freeItemBytes) {
    throw new Error(
      `Refusing paid Arweave upload: ${label} would be a ${item}-byte data item, over the Turbo/ArDrive free tier of ${freeItemBytes} bytes (105 KiB). ` +
      'Compact or split the receipt. Momo will not attempt a paid upload.',
    );
  }
}

export function assertNotCharged(res, label) {
  const winc = res?.winc;
  if (winc == null) {
    throw new Error(
      `Refusing to continue after ${label}: Turbo did not report winc, so it is not known to be free. ` +
      'Momo will not risk a paid upload.',
    );
  }
  if (String(winc) !== '0') {
    throw new Error(
      `Refusing to continue: ${label} was charged ${winc} winc, outside the Turbo free tier ` +
      '(105 KiB per item, 10 MiB lifetime per wallet). Momo will not silently continue a paid upload.',
    );
  }
}

export function assertFreeAllowance(totalBytes, bytesRemaining) {
  if (bytesRemaining == null) return;
  if (!Number.isFinite(bytesRemaining) || bytesRemaining < totalBytes) {
    const left = Number.isFinite(bytesRemaining) ? `${bytesRemaining} bytes` : 'an unknown allowance';
    throw new Error(
      `Refusing paid Arweave upload: this batch is ${totalBytes} bytes but the wallet free allowance has ${left} left ` +
      '(Turbo lifetime cap is 10 MiB per wallet and per IP). Momo will not attempt a paid upload.',
    );
  }
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Upload already-loaded receipts. `upload(data, tags)` must return {id, winc}.
 * When `upload` is omitted the call is a dry run. Nothing is uploaded once a
 * size or allowance check fails, and a non-zero winc aborts the rest.
 */
export async function uploadBuffers(files, opts = {}) {
  const freeItemBytes = opts.freeItemBytes ?? FREE_ITEM_BYTES;
  const overhead = opts.overhead ?? DATA_ITEM_OVERHEAD_BYTES;
  const chunkBytes = freeItemBytes - overhead;
  if (chunkBytes < 1) {
    throw new Error(
      `Refusing paid Arweave upload: free-tier item limit is ${freeItemBytes} bytes and a signed data item needs ${overhead} bytes of header and tags, ` +
      'so no payload can stay free. Momo will not attempt a paid upload.',
    );
  }
  const dryRun = opts.dryRun ?? !opts.upload;
  const prepared = [];
  let totalBytes = 0;
  for (const file of files) {
    if (file.synthetic) {
      prepared.push({ file, skipped: true });
      continue;
    }
    const packed = pack(file.raw, chunkBytes);
    packed.chunks.forEach((c, i) => guardChunk(c.byteLength, { freeItemBytes, overhead, label: `${file.name} chunk ${i}` }));
    const meta = file.meta ?? {};
    // Same shape as the manifest that will actually be posted (43-char txids),
    // so the allowance check cannot under-count it.
    const manifestPreview = Buffer.from(JSON.stringify({
      schema: 'momo/arweave-manifest/v1',
      receipt_sha256: packed.sha256,
      gzip_bytes: packed.gz.length,
      encoding: 'gzip, concat chunks in order, then gunzip. Each chunk_sha256 covers that gzip slice.',
      chunks: packed.chunks.map(() => '0'.repeat(43)),
      chunk_sha256: packed.chunks.map((c) => sha256hex(c)),
      variant: meta.requested_variant,
      gpu: meta.gpu,
      model: meta.model,
      prompts_sha256: meta.prompts_sha256,
      created: meta.created,
    }));
    guardChunk(manifestPreview.byteLength, { freeItemBytes, overhead, label: `${file.name} manifest` });
    totalBytes += packed.gz.length + manifestPreview.byteLength;
    prepared.push({ file, packed });
  }
  assertFreeAllowance(totalBytes, opts.bytesRemaining);
  const results = [];
  for (const item of prepared) {
    if (item.skipped) {
      const msg = `SKIP ${item.file.name}: synthetic test data must never be published`;
      console.error(msg);
      results.push({ file: item.file.name, skipped: 'synthetic' });
      continue;
    }
    const { file, packed } = item;
    const base = [{ name: 'App-Name', value: 'Momo' }, { name: 'Momo-Receipt-Sha256', value: packed.sha256 }];
    const ids = [];
    const chunkSha = packed.chunks.map((c) => sha256hex(c));
    for (let i = 0; i < packed.chunks.length; i++) {
      guardChunk(packed.chunks[i].byteLength, { freeItemBytes, overhead, label: `${file.name} chunk ${i}` });
      if (dryRun) {
        ids.push('DRYRUN-' + chunkSha[i].slice(0, 16));
        continue;
      }
      const res = await opts.upload(packed.chunks[i], [
        ...base,
        { name: 'Content-Type', value: 'application/octet-stream' },
        { name: 'Momo-Chunk', value: `${i}/${packed.chunks.length}` },
      ]);
      assertNotCharged(res, `${file.name} chunk ${i}/${packed.chunks.length}`);
      ids.push(res.id);
    }
    const meta = file.meta ?? {};
    const manifest = {
      schema: 'momo/arweave-manifest/v1',
      receipt_sha256: packed.sha256,
      gzip_bytes: packed.gz.length,
      encoding: 'gzip, concat chunks in order, then gunzip. Each chunk_sha256 covers that gzip slice.',
      chunks: ids,
      chunk_sha256: chunkSha,
      variant: meta.requested_variant,
      gpu: meta.gpu,
      model: meta.model,
      prompts_sha256: meta.prompts_sha256,
      created: meta.created,
    };
    const mbuf = Buffer.from(JSON.stringify(manifest));
    guardChunk(mbuf.byteLength, { freeItemBytes, overhead, label: `${file.name} manifest` });
    let manifestId;
    if (dryRun) {
      manifestId = 'DRYRUN-' + sha256hex(mbuf).slice(0, 16);
    } else {
      const res = await opts.upload(mbuf, [...base, { name: 'Content-Type', value: 'application/json' }, { name: 'Momo-Type', value: 'manifest' }]);
      assertNotCharged(res, `${file.name} manifest`);
      manifestId = res.id;
    }
    results.push({
      file: file.name,
      sha256: packed.sha256,
      manifest_txid: manifestId,
      chunk_txids: ids,
      chunk_sha256: chunkSha,
      dry_run: dryRun,
      gzip_bytes: packed.gz.length,
      chunks: packed.chunks,
    });
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);

  if (flag('--gen-wallet')) {
    const out = opt('--gen-wallet');
    const { default: Arweave } = await import('arweave');
    const jwk = await Arweave.init({}).wallets.generate();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(jwk), { mode: 0o600 });
    console.log('wallet written to', out, '(keep it private; back it up)');
    return;
  }
  const target = args.find((a) => !a.startsWith('--') && a !== opt('--wallet') && a !== opt('--gen-wallet'));
  if (!target) {
    console.error('usage: upload.mjs <receipt.json|dir> [--wallet f] [--sandbox] [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const filesOnDisk = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => f.endsWith('.json')).map((f) => path.join(target, f))
    : [target];
  const loaded = filesOnDisk.map((f) => {
    const raw = fs.readFileSync(f);
    let meta = {};
    let synthetic = false;
    try {
      const r = JSON.parse(raw);
      synthetic = Boolean(r.synthetic);
      meta = {
        requested_variant: r.requested_variant,
        gpu: r.gpu?.rows?.[0],
        model: r.model,
        prompts_sha256: r.prompts_sha256,
        created: r.created,
      };
    } catch {
      synthetic = false;
    }
    return { name: f, raw, synthetic, meta };
  });

  const dryRun = flag('--dry-run');
  let upload = null;
  let bytesRemaining;
  if (!dryRun) {
    const { TurboFactory } = await import('@ardrive/turbo-sdk/node');
    const jwk = JSON.parse(fs.readFileSync(opt('--wallet', path.join(process.env.HOME, '.momo/arweave-wallet.json'))));
    const cfg = flag('--sandbox') ? { uploadServiceConfig: { url: 'https://upload.services.ar-io.dev' } } : {};
    const turbo = TurboFactory.authenticated({ privateKey: jwk, ...cfg });
    if (typeof turbo.getFreeStatus !== 'function') {
      throw new Error('Refusing Arweave upload: this Turbo client cannot report the free-tier allowance. Momo will not attempt an upload that might be billed.');
    }
    let status;
    try {
      status = await turbo.getFreeStatus();
    } catch (e) {
      throw new Error(`Refusing Arweave upload: could not read the free-tier allowance (${e.message}). Momo will not attempt an upload that might be billed.`);
    }
    bytesRemaining = status?.bytesRemaining;
    upload = (data, tags) => turbo.upload({ data, dataItemOpts: { tags } });
  }
  const results = await uploadBuffers(loaded, { upload, dryRun, bytesRemaining });
  const log = path.join(HERE, 'uploads.jsonl');
  for (const line of results) {
    if (line.skipped) continue;
    const stored = { file: line.file, sha256: line.sha256, manifest_txid: line.manifest_txid, chunk_txids: line.chunk_txids, chunk_sha256: line.chunk_sha256, dry_run: line.dry_run };
    fs.appendFileSync(log, JSON.stringify(stored) + '\n');
    console.log(JSON.stringify(stored));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
