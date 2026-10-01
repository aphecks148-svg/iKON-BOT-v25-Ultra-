'use strict';

/**
 * Push the local repository to GitHub through the Git Data API.
 * Needed because this sandbox cannot exec git's HTTPS transport.
 *
 *   node push.js <owner/repo> <branch>
 *
 * Reuses the existing local commit's tree when possible; otherwise uploads the
 * working tree. Idempotent: existing blobs are reused by sha.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const target = process.argv[2] || 'aphecks148-svg/fb-economy-bot';
const branch = process.argv[3] || 'main';
const [owner, repo] = target.split('/');
const API = 'https://api.github.com';

const TOKEN = fs.readFileSync(path.join(process.env.HOME, '.gh-token'), 'utf8').trim();

function api(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(`${API}${endpoint}`, {
      method,
      headers: {
        // Fine-grained PATs must use the `token` scheme, not `Bearer`.
        Authorization: `token ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ikon-bot-push',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch { /* raw */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const msg = parsed && parsed.message ? parsed.message : data.slice(0, 200);
        return reject(new Error(`${method} ${endpoint} -> ${res.statusCode}: ${msg}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Files that must never be uploaded. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.harness']);
const SKIP_FILES = new Set(['.env']);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example' && entry.name !== '.gitignore') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), rel));
    } else {
      if (SKIP_FILES.has(entry.name)) continue;
      out.push(rel);
    }
  }
  return out;
}

(async function main() {
  let message = process.argv[4];
  if (!message) {
    try {
      message = require('fs').readFileSync('.git/COMMIT_EDITMSG', 'utf8').split('\n')[0].trim();
    } catch { message = ''; }
  }
  if (!message) message = 'feat: iKON-BOT foundation + core systems';

  const repoInfo = await api('GET', `/repos/${owner}/${repo}`);
  console.log(`target: ${repoInfo.full_name} (default ${repoInfo.default_branch})`);

  // Is there already a branch to build on?
  let baseCommit = null;
  try {
    const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    baseCommit = ref.object.sha;
    console.log(`existing ${branch}: ${baseCommit.slice(0, 7)}`);
  } catch {
    console.log(`${branch} does not exist yet — creating it`);
  }

  const files = walk(process.cwd()).sort();
  console.log(`uploading ${files.length} files…`);

  /** Git blob sha: sha1("blob " + len + "\0" + content). */
  const blobSha = (buf) => crypto.createHash('sha1')
    .update(Buffer.from(`blob ${buf.length}\0`, 'utf8'))
    .update(buf)
    .digest('hex');

  // Reuse blobs that already exist on the base tree.
  const existing = new Map();
  if (baseCommit) {
    try {
      const commit = await api('GET', `/repos/${owner}/${repo}/git/commits/${baseCommit}`);
      const tree = await api('GET', `/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
      for (const n of tree.tree || []) if (n.type === 'blob') existing.set(n.path, n.sha);
    } catch (e) { console.log(`(no base tree to reuse: ${e.message})`); }
  }

  const entries = [];
  let uploaded = 0;
  let reused = 0;

  for (const rel of files) {
    const content = fs.readFileSync(path.join(process.cwd(), rel));
    const sha = blobSha(content);
    if (existing.get(rel) === sha) {
      entries.push({ path: rel, mode: '100644', type: 'blob', sha });
      reused += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
    uploaded += 1;
  }

  console.log(`blobs: ${uploaded} new, ${reused} reused`);

  const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, { base_tree: baseCommit, tree: entries });
  console.log(`tree: ${tree.sha.slice(0, 7)}`);

  const commit = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: baseCommit ? [baseCommit] : [],
  });
  console.log(`commit: ${commit.sha.slice(0, 7)}`);

  const refPath = baseCommit ? `/git/refs/heads/${branch}` : `/git/refs`;
  const refBody = baseCommit
    ? { sha: commit.sha, force: false }
    : { ref: `refs/heads/${branch}`, sha: commit.sha };

  const updated = await api('PATCH', `/repos/${owner}/${repo}${refPath}`, refBody);
  console.log(`\n✅ pushed ${repoInfo.full_name}@${branch} -> ${updated.object.sha.slice(0, 7)}`);
  console.log(`   ${repoInfo.html_url}/tree/${branch}`);
})().catch((err) => {
  console.error(`\n❌ push failed: ${err.message}`);
  process.exit(1);
});
