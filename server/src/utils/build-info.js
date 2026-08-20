/**
 * Which build this is.
 *
 * "It is behaving oddly" and "which version are you on" is a conversation that had no answer:
 * the version lived only in `package.json`, the app displayed nothing, and `/health` reported
 * uptime. After a deploy nobody could tell whether the server had actually restarted with the
 * new code.
 *
 * Read once at import. The commit comes from `.git` when it is there — no build step, no
 * environment variable to remember — and simply from the version when it is not, which is what a
 * copied-out deployment looks like.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ROOT_DIR } from '../config/env.js';

/** When the process started, so "restart it" can be confirmed rather than assumed. */
const startedAt = new Date();

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * The checked-out commit, short, with a `+` when the working tree has uncommitted changes.
 *
 * Read from the files rather than by running `git`: spawning a process at import time to answer a
 * question this small is the sort of thing that makes a server slow to boot on a bad day, and a
 * deployment without git installed would fail rather than degrade.
 */
function readCommit() {
  try {
    const gitDir = path.join(ROOT_DIR, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();

    let sha = head;
    if (head.startsWith('ref:')) {
      const ref = head.slice(4).trim();
      try {
        sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim();
      } catch {
        // A packed ref: the loose file is gone, so read the table it went into.
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        const line = packed.split('\n').find((row) => row.endsWith(` ${ref}`));
        sha = line ? line.split(' ')[0] : '';
      }
    }
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/** The branch, which is usually the more useful half of "which build" during development. */
function readBranch() {
  try {
    const head = fs.readFileSync(path.join(ROOT_DIR, '.git', 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

const version = readVersion();
const commit = readCommit();
const branch = readBranch();

/**
 * @returns {{version: string, commit: string|null, branch: string|null, node: string,
 *   startedAt: string, uptime: number}}
 */
export function buildInfo() {
  return {
    version,
    commit,
    branch,
    node: process.versions.node,
    startedAt: startedAt.toISOString(),
    /** Seconds, so a client can say "up 3 days" without a second request. */
    uptime: Math.round(process.uptime()),
  };
}

/** `1.0.0 (a1694eb)` — one string, for a footer or a log line. */
export function buildLabel() {
  return commit ? `${version} (${commit})` : version;
}

export default buildInfo;
