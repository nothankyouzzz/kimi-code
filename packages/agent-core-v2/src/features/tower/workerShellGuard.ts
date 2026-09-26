import { isAbsolute, join, normalize, resolve } from 'pathe';

import type { IBashParserService } from '#/app/bashParser/bashParser';
import { isWithinDirectory } from '#/tool/path-access';
import { analyzeShellCommand } from '#/app/shellAnalysis/shellAnalysis';

export interface WorkerShellGuardOptions {
  readonly worktree: string;
  readonly initialCwd: string;
  readonly homeDir?: string;
}

export interface WorkerShellGuardResult {
  readonly allowed: boolean;
  readonly escapes: readonly string[];
}

const SAFE_DEV_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
]);

const EMPTY_VALUE_OPTIONS: ReadonlySet<string> = new Set();

function resolvePath(
  target: string,
  cwd: string | undefined,
  homeDir: string | undefined,
): string | undefined {
  if (target.length === 0) return undefined;
  if (/^\{[A-Za-z0-9_.-]*\}$/.test(target)) return undefined;
  if (isAbsolute(target)) {
    return normalize(target);
  }
  if (target === '~') {
    return homeDir !== undefined ? normalize(homeDir) : undefined;
  }
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return homeDir !== undefined ? normalize(join(homeDir, target.slice(2))) : undefined;
  }
  if (cwd !== undefined) {
    return normalize(resolve(cwd, target));
  }
  return undefined;
}

function checkEscape(
  candidate: string,
  cwd: string | undefined,
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  if (candidate.length === 0) return;
  if (/^\{[A-Za-z0-9_.-]*\}$/.test(candidate)) return;
  if (SAFE_DEV_TARGETS.has(candidate)) return;
  const resolved = resolvePath(candidate, cwd, homeDir);
  if (resolved !== undefined && !isWithinDirectory(resolved, worktree)) {
    escapes.push(resolved);
  }
}

export function evaluateWorkerBashCommand(
  command: string,
  options: WorkerShellGuardOptions,
  bashParser?: IBashParserService,
): WorkerShellGuardResult {
  const worktree = normalize(options.worktree);
  const initialCwd = normalize(options.initialCwd);
  const homeDir =
    options.homeDir !== undefined && options.homeDir.length > 0
      ? normalize(options.homeDir)
      : undefined;

  const analysis = analyzeShellCommand(command, bashParser, {
    initialCwd,
    homeDir,
    unwrapBusybox: false,
    launchWrapperValueOptions: EMPTY_VALUE_OPTIONS,
  });

  const escapes: string[] = [];
  let skipGitPaths = false;
  for (const target of analysis.writeTargets) {
    if (target.kind === 'git-dir') {
      const resolved = resolvePath(target.candidate, target.cwd, homeDir);
      if (resolved !== undefined && !isWithinDirectory(resolved, worktree)) {
        escapes.push(resolved);
        skipGitPaths = true;
      } else {
        skipGitPaths = false;
      }
      continue;
    }
    if (target.kind === 'git-path' && skipGitPaths) {
      continue;
    }
    checkEscape(target.candidate, target.cwd, worktree, homeDir, escapes);
  }

  if (escapes.length === 0) {
    return { allowed: true, escapes: [] };
  }
  return { allowed: false, escapes: [...new Set(escapes)] };
}
