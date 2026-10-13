import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const suiteRoot = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.dirname(suiteRoot);

// Linked worktrees must share durable session ownership, including attempts
// whose process exited before the effect could be reconciled.
let sharedSessionDirectory;
export function sessionLockDirectory() {
  if (sharedSessionDirectory) return sharedSessionDirectory;
  let primary = repositoryRoot;
  try {
    const listing = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const selected = listing.split('\0').find(line => line.startsWith('worktree '))?.slice(9);
    if (selected && path.isAbsolute(selected)) primary = path.resolve(selected);
  } catch { /* A source archive has no other linked worktrees. */ }
  // The existing root .env.* ignore rule also protects this shared subtree
  // before the harness branch is installed in the primary checkout.
  return sharedSessionDirectory = path.join(primary, 'website-tests', 'artifacts', '.env.session-locks');
}
