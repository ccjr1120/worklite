import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);

export type GitRepositoryInfo = {
  // The primary checkout the task was dispatched against (merge-back target).
  projectDirectory: string;
  branch: string | null;
  commit: string;
};

export type PreparedTaskWorktree = {
  worktreePath: string;
  worktreeBranch: string;
  baseBranch: string;
  baseCommit: string;
};

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', directory, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

// Returns null when the directory is not inside a git work tree; callers keep native-directory
// behavior for such projects.
export async function inspectGitRepository(projectDirectory: string): Promise<GitRepositoryInfo | null> {
  try {
    await git(projectDirectory, ['rev-parse', '--is-inside-work-tree']);
    const [branch, commit] = await Promise.all([
      git(projectDirectory, ['branch', '--show-current']),
      git(projectDirectory, ['rev-parse', 'HEAD']),
    ]);
    return { projectDirectory, branch: branch || null, commit };
  } catch {
    return null;
  }
}

// Serializes merge-back per original checkout and base branch so parallel tasks and Team
// developer lanes of one repository never merge concurrently. Entries clean up once settled.
const mergeQueues = new Map<string, Promise<unknown>>();

export function enqueueTaskMerge<T>(projectDirectory: string, baseBranch: string, run: () => Promise<T>): Promise<T> {
  const key = `${projectDirectory}#${baseBranch}`;
  const queued = (mergeQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  mergeQueues.set(key, queued);
  void queued.finally(() => { if (mergeQueues.get(key) === queued) mergeQueues.delete(key); });
  return queued;
}

// Each task works in its own worktree so same-directory tasks can run in parallel. The worktree
// branches from the current branch's HEAD; uncommitted working-tree changes are never included.
// A same-suffix remnant makes the add fail with a clear error rather than sharing another
// task's worktree.
export async function prepareTaskWorktree(repository: GitRepositoryInfo & { branch: string }, taskId: string): Promise<PreparedTaskWorktree> {
  const suffix = taskId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase() || randomSuffix();
  const worktreeBranch = `worklite/task-${suffix}`;
  const worktreePath = join(dirname(repository.projectDirectory), `${basename(repository.projectDirectory)}-worklite-task-${suffix}`);
  await git(repository.projectDirectory, ['worktree', 'add', '-b', worktreeBranch, worktreePath, repository.commit]);
  return { worktreePath, worktreeBranch, baseBranch: repository.branch, baseCommit: repository.commit };
}

// Idempotent variant for attempts that may resume (Team developer lanes): an existing worktree
// and branch for the same suffix are reused instead of recreated.
export async function ensureTaskWorktree(repository: GitRepositoryInfo & { branch: string }, suffix: string): Promise<PreparedTaskWorktree> {
  const worktreeBranch = `worklite/task-${suffix}`;
  const worktreePath = join(dirname(repository.projectDirectory), `${basename(repository.projectDirectory)}-worklite-task-${suffix}`);
  const existing = await git(repository.projectDirectory, ['worktree', 'list', '--porcelain']).catch(() => '');
  if (existing.split('\n').some((line) => line === `worktree ${worktreePath}`)) {
    return { worktreePath, worktreeBranch, baseBranch: repository.branch, baseCommit: repository.commit };
  }
  await git(repository.projectDirectory, ['worktree', 'add', '-b', worktreeBranch, worktreePath, repository.commit]);
  return { worktreePath, worktreeBranch, baseBranch: repository.branch, baseCommit: repository.commit };
}

// Idempotent ensure with explicit path, branch, and start point (Team Run base worktrees and
// lane sub-worktrees). An already-registered worktree at the path is reused; a leftover branch
// without a worktree (interrupted earlier attempt) is attached instead of recreated.
export async function ensureWorktreeAt(repositoryDirectory: string, worktreePath: string, worktreeBranch: string, startPoint: string): Promise<void> {
  const existing = await git(repositoryDirectory, ['worktree', 'list', '--porcelain']).catch(() => '');
  if (existing.split('\n').some((line) => line === `worktree ${worktreePath}`)) return;
  const branchExists = await git(repositoryDirectory, ['rev-parse', '--verify', `refs/heads/${worktreeBranch}`]).then(() => true).catch(() => false);
  if (branchExists) {
    await git(repositoryDirectory, ['worktree', 'add', worktreePath, worktreeBranch]);
    return;
  }
  await git(repositoryDirectory, ['worktree', 'add', '-b', worktreeBranch, worktreePath, startPoint]);
}

export type TaskMergeOutcome =
  | { status: 'merged'; cleanupPending: boolean }
  | { status: 'conflict'; error: string };

// Merges the task branch back into the base branch on the original checkout. Callers serialize
// merges per repository and branch. A conflict (or a checkout that moved off the base branch)
// aborts the merge and retains the worktree and branch for manual resolution.
export async function mergeTaskWorktree(task: { projectDirectory: string; worktreePath: string; worktreeBranch: string; baseBranch: string }): Promise<TaskMergeOutcome> {
  const currentBranch = await git(task.projectDirectory, ['branch', '--show-current']);
  if (currentBranch !== task.baseBranch) {
    return { status: 'conflict', error: `原工作区当前在分支 ${currentBranch || '(detached HEAD)'}，已不在任务捕获时的分支 ${task.baseBranch}，未执行自动合并；任务分支 ${task.worktreeBranch} 与 worktree ${task.worktreePath} 已保留，请手动合并。` };
  }
  // Merge only integrates committed work, so commit whatever the executor left uncommitted in
  // its worktree first; the worktree is the task's own workspace, so this touches nothing else.
  const dirty = await git(task.worktreePath, ['status', '--porcelain']);
  if (dirty) {
    await git(task.worktreePath, ['add', '-A']);
    await git(task.worktreePath, ['commit', '-m', `chore(worklite): commit remaining task changes on ${task.worktreeBranch}`]);
  }
  try {
    await git(task.projectDirectory, ['merge', '--no-ff', task.worktreeBranch]);
  } catch (error) {
    const conflicting = await git(task.projectDirectory, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    await git(task.projectDirectory, ['merge', '--abort']).catch(() => undefined);
    const detail = conflicting ? `冲突文件：${conflicting.split('\n').join('、')}` : `合并输出：${errorMessage(error)}`;
    return { status: 'conflict', error: `自动合并任务分支 ${task.worktreeBranch} 到 ${task.baseBranch} 失败（${detail}）；worktree ${task.worktreePath} 与分支已保留，请手动合并后清理。` };
  }
  let cleanupPending = false;
  try {
    await git(task.projectDirectory, ['worktree', 'remove', task.worktreePath]);
  } catch {
    try { await git(task.projectDirectory, ['worktree', 'remove', '--force', task.worktreePath]); }
    catch { cleanupPending = true; }
  }
  if (!cleanupPending) await git(task.projectDirectory, ['branch', '-d', task.worktreeBranch]).catch(() => { cleanupPending = true; });
  return { status: 'merged', cleanupPending };
}

// A merge interrupted by an API restart can leave MERGE_HEAD behind; abort it so the original
// checkout is usable and the task reports the interrupted merge as a conflict.
export async function reconcileInterruptedMerge(task: { projectDirectory: string }): Promise<boolean> {
  const merging = await git(task.projectDirectory, ['rev-parse', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false);
  if (merging) await git(task.projectDirectory, ['merge', '--abort']).catch(() => undefined);
  return merging;
}

// Best-effort removal of a task worktree and its branch (used when capture fails after creation).
export async function removeTaskWorktree(projectDirectory: string, worktreePath: string, worktreeBranch: string): Promise<void> {
  await git(projectDirectory, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
  await git(projectDirectory, ['branch', '-D', worktreeBranch]).catch(() => undefined);
}

function errorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
