// The job container downloads probe.py and prompts.json from GitHub at the
// commit baked into nosana/generated. A fake commit (the test suite used to
// write "abc123" into those tracked files) 404s on the node after a GPU is
// assigned, and the timeout is still billed.
import crypto from 'node:crypto';

const PIN_RE = /\('([^']+)','(https:\/\/raw\.githubusercontent\.com\/[^']+)','([0-9a-fA-F]{64})'\)/g;

export function extractPins(job) {
  const cmd = job?.ops?.[0]?.args?.cmd?.[0];
  if (typeof cmd !== 'string' || !cmd.includes('probe')) {
    return { ok: false, error: 'Job definition has no probe download command. Refusing to post.' };
  }
  const files = [];
  const commits = new Set();
  for (const m of cmd.matchAll(PIN_RE)) {
    const name = m[1];
    const url = m[2];
    const sha256 = m[3];
    const commit = url.match(/githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//)?.[1] ?? '';
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      return {
        ok: false,
        error: `Job is pinned to "${commit || '(missing)'}", not a 40-character git commit. ` +
          'Refusing to post: the node would fail downloading the probe and the GPU time would still be billed. ' +
          'Rebuild with `python3 nosana/build_jobs.py --commit $(git rev-parse HEAD)` after that commit is pushed. ' +
          'Do not run the builder without --out from tests; that used to overwrite nosana/generated with a fake commit.',
      };
    }
    commits.add(commit);
    files.push({ name, url, sha256 });
  }
  if (!files.length) {
    return { ok: false, error: 'Job definition does not pin probe.py and prompts.json to a commit and sha256. Refusing to post.' };
  }
  if (commits.size !== 1) {
    return { ok: false, error: `Job pins more than one commit (${[...commits].join(', ')}). Refusing to post.` };
  }
  for (const name of ['probe.py', 'prompts.json']) {
    if (!files.some((f) => f.name === name)) {
      return { ok: false, error: `Job does not pin ${name}. Refusing to post.` };
    }
  }
  return { ok: true, commit: [...commits][0], files };
}

/**
 * readFile(commit, name) returns a Buffer of that path at that commit, or null
 * if the commit/file is not available. Hash mismatch means the node will exit
 * "sha mismatch" after the GPU is already assigned.
 */
export function verifyPins(job, readFile) {
  const pins = extractPins(job);
  if (!pins.ok) return pins;
  for (const f of pins.files) {
    const buf = readFile(pins.commit, f.name);
    if (buf == null) {
      return {
        ok: false,
        error: `Commit ${pins.commit} is not in this checkout (or ${f.name} is missing there). ` +
          'Refusing to post a job that cannot fetch the probe it will hash-check.',
      };
    }
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== f.sha256) {
      return {
        ok: false,
        error: `sha256 of ${f.name} at ${pins.commit} is ${got}, but the job expects ${f.sha256}. ` +
          'The node would exit on sha mismatch after a GPU is assigned. ' +
          'Rebuild and push before spending: python3 nosana/build_jobs.py --commit $(git rev-parse HEAD)',
      };
    }
  }
  return pins;
}
