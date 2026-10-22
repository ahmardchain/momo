"""Recover a receipt JSON from Nosana job log text (stdin or file)."""
import base64, gzip, hashlib, json, re, sys

def decode(text: str) -> dict:
    m = re.search(r"===GHRECEIPT BEGIN (\d+) ([0-9a-f]{64})===", text)
    if not m:
        raise ValueError("no receipt marker in logs")
    n, digest = int(m.group(1)), m.group(2)
    parts = dict(re.findall(r"GHR (\d{5}) ([A-Za-z0-9+/=]+)", text))
    if len(parts) != n:
        raise ValueError(f"expected {n} chunks, got {len(parts)}")
    blob = "".join(parts[f"{i:05d}"] for i in range(n))
    if hashlib.sha256(blob.encode()).hexdigest() != digest:
        raise ValueError("chunk digest mismatch")
    return json.loads(gzip.decompress(base64.b64decode(blob)))

if __name__ == "__main__":
    src = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
    r = decode(src)
    out = sys.argv[2] if len(sys.argv) > 2 else None
    s = json.dumps(r)
    (open(out, "w").write(s) if out else print(s))
