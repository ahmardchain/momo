// Momo: upload receipts to Arweave via ar.io Turbo.
// Free tier: items <= 105 KiB are free on mainnet (10 MiB lifetime per wallet) — https://docs.ar.io/build/upload/upload-and-verify/
// Receipts are gzipped and split into <=100 KiB chunks plus a small JSON manifest, so every item stays in the free tier.
//
// Usage:
//   node arweave/upload.mjs <receipt.json|dir> [--wallet ~/.momo/arweave-wallet.json] [--sandbox] [--dry-run]
// Wallet: an Arweave JWK (generate free & offline: `node arweave/upload.mjs --gen-wallet ~/.momo/arweave-wallet.json`).
// Writes arweave/uploads.jsonl with {file, sha256, manifest_txid, chunk_txids}.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
const args = process.argv.slice(2); const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const CHUNK = 100 * 1024;

if (flag('--gen-wallet')) {
  const out = opt('--gen-wallet');
  const { default: Arweave } = await import('arweave');
  const jwk = await Arweave.init({}).wallets.generate();
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(jwk), { mode: 0o600 });
  console.log('wallet written to', out, '(keep it private; back it up)'); process.exit(0);
}
const target = args.find((a) => !a.startsWith('--') && a !== opt('--wallet'));
if (!target) { console.error('usage: upload.mjs <receipt.json|dir> [--wallet f] [--sandbox] [--dry-run]'); process.exit(1); }
const files = fs.statSync(target).isDirectory() ? fs.readdirSync(target).filter((f) => f.endsWith('.json')).map((f) => path.join(target, f)) : [target];

export function pack(buf) {
  const gz = zlib.gzipSync(buf, { level: 9 }); const chunks = [];
  for (let i = 0; i < gz.length; i += CHUNK) chunks.push(gz.subarray(i, i + CHUNK));
  return { gz, chunks, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

let turbo = null;
if (!flag('--dry-run')) {
  const { TurboFactory, ArweaveSigner } = await import('@ardrive/turbo-sdk/node');
  const jwk = JSON.parse(fs.readFileSync(opt('--wallet', path.join(process.env.HOME, '.momo/arweave-wallet.json'))));
  const cfg = flag('--sandbox') ? { uploadServiceConfig: { url: 'https://upload.services.ar-io.dev' } } : {};
  turbo = TurboFactory.authenticated({ privateKey: jwk, ...cfg });
  void ArweaveSigner;
}
const up = async (data, tags) => {
  if (!turbo) return { id: 'DRYRUN-' + crypto.createHash('sha256').update(data).digest('hex').slice(0, 16), winc: '0' };
  return turbo.upload({ data, dataItemOpts: { tags } });
};
for (const f of files) {
  const raw = fs.readFileSync(f); const r = JSON.parse(raw);
  if (r.synthetic) { console.error(`SKIP ${f}: synthetic test data must never be published`); continue; }
  const { gz, chunks, sha256 } = pack(raw); const base = [{ name: 'App-Name', value: 'Momo' }, { name: 'Momo-Receipt-Sha256', value: sha256 }];
  const ids = [];
  for (let i = 0; i < chunks.length; i++) {
    const res = await up(chunks[i], [...base, { name: 'Content-Type', value: 'application/octet-stream' }, { name: 'Momo-Chunk', value: `${i}/${chunks.length}` }]);
    if (res.winc && res.winc !== '0') console.warn('note: chunk was not free, winc =', res.winc); ids.push(res.id);
  }
  const manifest = { schema: 'momo/arweave-manifest/v1', receipt_sha256: sha256, gzip_bytes: gz.length, encoding: 'gzip, concat chunks in order',
    chunks: ids, variant: r.requested_variant, gpu: r.gpu?.rows?.[0], model: r.model, prompts_sha256: r.prompts_sha256, created: r.created };
  const m = await up(Buffer.from(JSON.stringify(manifest)), [...base, { name: 'Content-Type', value: 'application/json' }, { name: 'Momo-Type', value: 'manifest' }]);
  const line = { file: f, sha256, manifest_txid: m.id, chunk_txids: ids, dry_run: !turbo };
  fs.appendFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'uploads.jsonl'), JSON.stringify(line) + '\n');
  console.log(JSON.stringify(line));
}
