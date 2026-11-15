// Re-download a receipt from its manifest txid and verify sha256 — anyone can audit Momo results.
// Usage: node arweave/fetch.mjs <manifest_txid> [out.json] [--gateway https://arweave.net]
import fs from 'node:fs'; import zlib from 'node:zlib'; import crypto from 'node:crypto';
const [id, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const gw = process.argv.includes('--gateway') ? process.argv[process.argv.indexOf('--gateway') + 1] : 'https://arweave.net';
const get = async (t) => Buffer.from(await (await fetch(`${gw}/raw/${t}`)).arrayBuffer());
const m = JSON.parse(await get(id));
const parts = await Promise.all(m.chunks.map(get));
if (Array.isArray(m.chunk_sha256)) {
  if (m.chunk_sha256.length !== parts.length) {
    console.error(`chunk count ${parts.length} != manifest ${m.chunk_sha256.length}`);
    process.exit(2);
  }
  for (let i = 0; i < parts.length; i++) {
    const got = crypto.createHash('sha256').update(parts[i]).digest('hex');
    if (got !== m.chunk_sha256[i]) {
      console.error(`chunk ${i} sha256 mismatch`);
      process.exit(2);
    }
  }
}
const raw = zlib.gunzipSync(Buffer.concat(parts));
const ok = crypto.createHash('sha256').update(raw).digest('hex') === m.receipt_sha256;
console.log({ variant: m.variant, gpu: m.gpu, sha256_ok: ok, chunks: parts.length });
if (out) fs.writeFileSync(out, raw);
if (!ok) process.exit(2);
