'use strict';

/**
 * Patch ws3-fca's thread formatters.
 *
 * ws3-fca 3.5.2 reads every participant's profile picture as
 * `messaging_actor.big_image_src.uri` — unguarded. Any chat (or
 * thread-info fetch) that includes an account without a profile
 * image makes the whole call throw "Cannot read properties of
 * undefined (reading 'uri')". On a real deploy that took down the
 * boot-time thread cache and the approval sweep, and it can break
 * the admin check in any chat whose members include such an account.
 *
 * The fix is the guard the library should have shipped: read the
 * uri only when the image is there. Applied on every install, and
 * idempotent — a second run changes nothing, and a ws3-fca version
 * that fixed this upstream is left alone.
 */

const fs = require('fs');
const path = require('path');

const TARGETS = [
  'src/deltas/apis/threads/getThreadList.js',
  'src/deltas/apis/threads/getThreadInfo.js',
];

const BROKEN = 'd.node.messaging_actor.big_image_src.uri';
const FIXED = '(d.node.messaging_actor.big_image_src && d.node.messaging_actor.big_image_src.uri)';

const root = path.resolve(__dirname, '..', 'node_modules', 'ws3-fca');

let patched = 0;
let skipped = 0;

for (const rel of TARGETS) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`[PATCH] ws3-fca ${rel} not found — skipping`);
    skipped += 1;
    continue;
  }
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(FIXED)) {
    // Already patched by this script.
    skipped += 1;
    continue;
  }
  if (!before.includes(BROKEN)) {
    // A version that fixed it upstream in its own way.
    skipped += 1;
    continue;
  }
  fs.writeFileSync(file, before.split(BROKEN).join(FIXED));
  console.log(`[PATCH] ws3-fca ${rel}: guarded big_image_src.uri`);
  patched += 1;
}

if (patched === 0) {
  console.log('[PATCH] ws3-fca thread formatters already guarded — nothing to do');
}
