// JS twin of probe/decode_logs.py. Logs in IPFS results may JSON-escape newlines, so we match tokens not lines.
import zlib from 'node:zlib'; import crypto from 'node:crypto';
export function decodeReceipt(text) {
  const m = text.match(/===GHRECEIPT BEGIN (\d+) ([0-9a-f]{64})===/); if (!m) throw new Error('no receipt marker');
  const n = Number(m[1]); const parts = {};
  for (const x of text.matchAll(/GHR (\d{5}) ([A-Za-z0-9+/=]+)/g)) parts[x[1]] = x[2];
  const blob = Array.from({ length: n }, (_, i) => parts[String(i).padStart(5, '0')]).join('');
  if (Object.keys(parts).length !== n) throw new Error(`chunks ${Object.keys(parts).length}/${n}`);
  if (crypto.createHash('sha256').update(blob).digest('hex') !== m[2]) throw new Error('digest mismatch');
  return JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')));
}
