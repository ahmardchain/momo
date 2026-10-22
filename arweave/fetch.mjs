// Re-download a receipt from its manifest txid and verify sha256 — anyone can audit Momo results.
// Usage: node arweave/fetch.mjs <manifest_txid> [out.json] [--gateway https://arweave.net]
import fs from 'node:fs'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
const [id, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const gw = process.argv.includes('--gateway') ? process.argv[process.argv.indexOf('--gateway') + 1] : 'https://arweave.net';
const get = async (t) => Buffer.from(await (await fetch(`${gw}/raw/${t}`)).arrayBuffer());
const m = JSON.parse(await get(id));
const raw = zlib.gunzipSync(Buffer.concat(await Promise.all(m.chunks.map(get))));
const ok = crypto.createHash('sha256').update(raw).digest('hex') === m.receipt_sha256;
console.log({ variant: m.variant, gpu: m.gpu, sha256_ok: ok });
if (out) fs.writeFileSync(out, raw);
if (!ok) process.exit(2);
