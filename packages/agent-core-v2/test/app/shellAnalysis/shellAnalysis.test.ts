import { describe, expect, it } from 'vitest';
import { BashParserService } from '#/app/bashParser/bashParserService';
import {
  analyzeShellCommand,
  extractLiteralText,
  isFindExecDestructive,
  normalizeCommandName,
  unwrapInvocation,
} from '#/app/shellAnalysis/shellAnalysis';

describe('shellAnalysis', () => {
  const parser = new BashParserService();

  describe('normalizeCommandName', () => {
    it('normalizes paths, cases, and extensions', () => {
      expect(normalizeCommandName('/usr/bin/SUDO')).toBe('sudo');
      expect(normalizeCommandName('C:\\Windows\\System32\\cmd.EXE')).toBe('cmd');
      expect(normalizeCommandName('bash')).toBe('bash');
    });
  });

  describe('extractLiteralText', () => {
    it('extracts unescaped literals and handles quotes', () => {
      const parsed = parser.parse('echo "hello world" \'single\' raw\\ word 123');
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const cmd = parsed.root.children[0]!;
      const args = cmd.children.slice(1).map((child) => extractLiteralText(child));
      expect(args).toEqual(['hello world', 'single', 'raw word', '123']);
    });

    it('returns undefined for variable expansions with default unsafe pattern', () => {
      const parsed = parser.parse('echo $VAR "$VAR" `date`');
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const cmd = parsed.root.children[0]!;
      const args = cmd.children.slice(1).map((child) => extractLiteralText(child));
      expect(args).toEqual([undefined, undefined, undefined]);
    });

    it('honors custom unsafeOperandPattern', () => {
      const parsed = parser.parse('echo /tmp/* ~ [a-z]');
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const cmd = parsed.root.children[0]!;
      const defaultArgs = cmd.children.slice(1).map((child) => extractLiteralText(child));
      expect(defaultArgs).toEqual(['/tmp/*', '~', '[a-z]']);

      const strictPattern = /[$`*?[\]~]/;
      const strictArgs = cmd.children
        .slice(1)
        .map((child) => extractLiteralText(child, strictPattern));
      expect(strictArgs).toEqual([undefined, undefined, undefined]);
    });

    it('respects allowConcatenation parameter', () => {
      const parsed = parser.parse('"l"\'s\' -la');
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const cmd = parsed.root.children[0]!;
      const nameNode = cmd.children[0]!.children.find((c) => c.isNamed)!;
      expect(extractLiteralText(nameNode, undefined, true)).toBe('ls');
      expect(extractLiteralText(nameNode, undefined, false)).toBeUndefined();
    });
  });

  describe('unwrapInvocation', () => {
    it('unwraps privilege wrappers with options', () => {
      const unwrapped = unwrapInvocation('sudo', ['-u', 'root', '--host', 'remote', 'reboot']);
      expect(unwrapped.name).toBe('reboot');
      expect(unwrapped.args).toEqual([]);
      expect(unwrapped.dropped).toBe(false);
    });

    it('unwraps env wrapper skipping assignments and flags', () => {
      const unwrapped = unwrapInvocation('env', ['-i', 'FOO=bar', 'BAR=1', 'shutdown', '-h', 'now']);
      expect(unwrapped.name).toBe('shutdown');
      expect(unwrapped.args).toEqual(['-h', 'now']);
      expect(unwrapped.dropped).toBe(false);
    });

    it('unwraps timeout wrapper skipping duration operand', () => {
      const unwrapped = unwrapInvocation('timeout', ['-k', '1s', '10', 'rm', '-rf', 'dir']);
      expect(unwrapped.name).toBe('rm');
      expect(unwrapped.args).toEqual(['-rf', 'dir']);
      expect(unwrapped.dropped).toBe(false);
    });

    it('unwraps stdbuf wrapper', () => {
      const unwrapped = unwrapInvocation('stdbuf', ['-oL', '-eL', 'poweroff']);
      expect(unwrapped.name).toBe('poweroff');
      expect(unwrapped.args).toEqual([]);
      expect(unwrapped.dropped).toBe(false);
    });

    it('unwraps busybox applet when enabled', () => {
      const unwrapped = unwrapInvocation('busybox', ['poweroff'], { unwrapBusybox: true });
      expect(unwrapped.name).toBe('poweroff');
      expect(unwrapped.args).toEqual([]);

      const disabled = unwrapInvocation('busybox', ['poweroff'], { unwrapBusybox: false });
      expect(disabled.name).toBe('busybox');
      expect(disabled.args).toEqual(['poweroff']);
    });

    it('does not unwrap busybox flag like --list', () => {
      const unwrapped = unwrapInvocation('busybox', ['--list']);
      expect(unwrapped.name).toBe('busybox');
      expect(unwrapped.args).toEqual(['--list']);
    });

    it('identifies command -v probe and does not unwrap to target', () => {
      const unwrapped = unwrapInvocation('command', ['-v', 'rm']);
      expect(unwrapped.isProbe).toBe(true);
      expect(unwrapped.name).toBe('command');
    });

    it('unwraps chained wrappers', () => {
      const unwrapped = unwrapInvocation('sudo', [
        'timeout',
        '5',
        'env',
        'FOO=1',
        'nice',
        '-n',
        '2',
        'reboot',
      ]);
      expect(unwrapped.name).toBe('reboot');
      expect(unwrapped.args).toEqual([]);
    });

    it('respects unwrapTimeout: false parameter', () => {
      const unwrapped = unwrapInvocation('timeout', ['5', 'rm', '-rf', '/'], {
        unwrapTimeout: false,
      });
      expect(unwrapped.name).toBe('timeout');
      expect(unwrapped.args).toEqual(['5', 'rm', '-rf', '/']);
    });
  });

  describe('isFindExecDestructive', () => {
    it('returns true for known destructive commands', () => {
      expect(isFindExecDestructive('rm', ['-rf'])).toBe(true);
      expect(isFindExecDestructive('mv', [])).toBe(true);
      expect(isFindExecDestructive('sed', ['-i', 's/a/b/'])).toBe(true);
      expect(isFindExecDestructive('perl', ['-i', '-pe', 's/a/b/'])).toBe(true);
    });

    it('returns false for non-destructive commands', () => {
      expect(isFindExecDestructive('cp', [])).toBe(false);
      expect(isFindExecDestructive('sed', ['-n', '1p'])).toBe(false);
      expect(isFindExecDestructive('perl', ['-ne', 'print'])).toBe(false);
      expect(isFindExecDestructive('git', ['status'])).toBe(false);
    });
  });

  describe('analyzeShellCommand', () => {
    it('handles syntax errors with unanalyzable flag', () => {
      const result = analyzeShellCommand('echo "unterminated', parser);
      expect(result.unanalyzable).toBe(true);
      expect(result.commands).toEqual([]);
      expect(result.writeTargets).toEqual([]);
    });

    it('extracts simple commands and targets', () => {
      const result = analyzeShellCommand('echo "hello" > out.txt && rm file.txt', parser, {
        initialCwd: '/work',
      });
      expect(result.unanalyzable).toBe(false);
      expect(result.commands.map((c) => c.name)).toEqual(['echo', 'rm']);
      expect(result.writeTargets).toEqual([
        { candidate: 'out.txt', cwd: '/work' },
        { candidate: 'file.txt', cwd: '/work' },
      ]);
    });

    it('tracks cwd through cd and pushd', () => {
      const result = analyzeShellCommand('cd /sub && touch a.txt', parser, {
        initialCwd: '/work',
      });
      expect(result.commands.map((c) => ({ name: c.name, cwd: c.cwd }))).toEqual([
        { name: 'cd', cwd: '/work' },
        { name: 'touch', cwd: '/sub' },
      ]);
      expect(result.writeTargets).toEqual([{ candidate: 'a.txt', cwd: '/sub' }]);
    });

    it('shares cwd across sibling commands inside subshell', () => {
      const result = analyzeShellCommand('(cd /sub; touch a.txt)', parser, {
        initialCwd: '/work',
      });
      expect(result.writeTargets).toEqual([{ candidate: 'a.txt', cwd: '/sub' }]);
    });

    it('isolates cwd in pipelines and subshells from caller', () => {
      const result = analyzeShellCommand(
        '(cd /sub; touch a.txt) && touch b.txt',
        parser,
        { initialCwd: '/work' },
      );
      expect(result.writeTargets).toEqual([
        { candidate: 'a.txt', cwd: '/sub' },
        { candidate: 'b.txt', cwd: '/work' },
      ]);
    });

    it('isolates nested-shell cwd from outer walk', () => {
      const result = analyzeShellCommand("bash -c 'cd /outside'; touch f.txt", parser, {
        initialCwd: '/work',
      });
      expect(result.writeTargets).toEqual([{ candidate: 'f.txt', cwd: '/work' }]);
    });

    it('invalidates cwd on divergent branches', () => {
      const result = analyzeShellCommand(
        'if true; then cd /sub; else cd /other; fi && rm x.txt',
        parser,
        { initialCwd: '/work' },
      );
      const rmCmd = result.commands.find((c) => c.name === 'rm');
      expect(rmCmd?.cwd).toBeUndefined();
      expect(result.writeTargets.find((w) => w.candidate === 'x.txt')?.cwd).toBeUndefined();
    });

    it('traverses command and process substitutions', () => {
      const result = analyzeShellCommand(
        'diff <(echo a > f1) >(tee f2) && echo $(rm f3)',
        parser,
        { initialCwd: '/work' },
      );
      expect(result.commands.map((c) => c.name)).toEqual(['echo', 'tee', 'diff', 'rm', 'echo']);
      expect(result.writeTargets).toEqual([
        { candidate: 'f1', cwd: '/work' },
        { candidate: 'f2', cwd: '/work' },
        { candidate: 'f3', cwd: '/work' },
      ]);
    });

    it('traverses nested shell commands with -c', () => {
      const result = analyzeShellCommand('bash -lc "rm -rf dir"', parser, {
        initialCwd: '/work',
      });
      expect(result.unanalyzable).toBe(false);
      expect(result.commands.map((c) => c.name)).toEqual(['bash', 'rm']);
      expect(result.writeTargets).toEqual([{ candidate: 'dir', cwd: '/work' }]);
    });

    it('marks unanalyzable when nested shell payload exceeds depth cap', () => {
      let deep = 'echo hi';
      for (let i = 0; i < 5; i += 1) {
        deep = `bash -c '${deep.replaceAll("'", "'\\''")}'`;
      }
      const capped = analyzeShellCommand(deep, parser, { maxDepth: 4 });
      expect(capped.unanalyzable).toBe(true);

      const uncapped = analyzeShellCommand(deep, parser);
      expect(uncapped.unanalyzable).toBe(false);
    });

    it('marks unanalyzable when nested shell payload is dynamic', () => {
      const result = analyzeShellCommand('bash -c "$DYNAMIC_CMD"', parser);
      expect(result.unanalyzable).toBe(true);
    });

    it('traverses eval and handles dynamic args', () => {
      const staticEval = analyzeShellCommand('eval "rm -rf dir"', parser, {
        initialCwd: '/work',
      });
      expect(staticEval.unanalyzable).toBe(false);
      expect(staticEval.commands.map((c) => c.name)).toEqual(['eval', 'rm']);

      const dynamicEval = analyzeShellCommand('eval $DIR', parser);
      expect(dynamicEval.unanalyzable).toBe(true);
    });

    it('dispatches find -exec and -delete', () => {
      const result = analyzeShellCommand(
        'find /search -name "*.tmp" -exec rm {} + && find /other -delete',
        parser,
        { initialCwd: '/work' },
      );
      expect(result.commands.map((c) => c.name)).toEqual(['find', 'rm', 'find']);
      expect(result.writeTargets).toEqual([
        { candidate: '/search', cwd: '/work' },
        { candidate: '/other', cwd: '/work' },
      ]);
    });

    it('dispatches xargs payload when enabled', () => {
      const result = analyzeShellCommand('ls | xargs -I{} cp {} /dest', parser, {
        initialCwd: '/work',
      });
      expect(result.commands.map((c) => c.name)).toEqual(['ls', 'xargs', 'cp']);
      expect(result.writeTargets).toEqual([{ candidate: '/dest', cwd: '/work' }]);

      const disabled = analyzeShellCommand('ls | xargs -I{} cp {} /dest', parser, {
        initialCwd: '/work',
        dispatchXargs: false,
      });
      expect(disabled.commands.map((c) => c.name)).toEqual(['ls', 'xargs']);
    });

    it('extracts write targets from git mutating commands', () => {
      const mutating = analyzeShellCommand('git checkout -b feat', parser, {
        initialCwd: '/repo',
      });
      expect(mutating.writeTargets).toEqual([{ candidate: '/repo', cwd: '/repo', kind: 'git-dir' }]);

      const readOnly = analyzeShellCommand('git status && git branch && git tag -l', parser, {
        initialCwd: '/repo',
      });
      expect(readOnly.writeTargets).toEqual([]);
    });

    it('extracts write targets from node and python evaluations', () => {
      const nodeResult = analyzeShellCommand(
        'node -e "fs.writeFileSync(\'/tmp/node.txt\', \'x\')"',
        parser,
        { initialCwd: '/work' },
      );
      expect(nodeResult.writeTargets).toEqual([{ candidate: '/tmp/node.txt', cwd: '/work' }]);

      const pyResult = analyzeShellCommand(
        'python3 -c "open(\'/tmp/py.txt\', \'w\')"',
        parser,
        { initialCwd: '/work' },
      );
      expect(pyResult.writeTargets).toEqual([{ candidate: '/tmp/py.txt', cwd: '/work' }]);
    });

    it('marks unanalyzable when dynamic command name is encountered', () => {
      const result = analyzeShellCommand('$CMD --flag', parser);
      expect(result.unanalyzable).toBe(true);
    });

    it('marks unanalyzable when wrapper has dynamic inner command', () => {
      const result = analyzeShellCommand('sudo $CMD', parser);
      expect(result.unanalyzable).toBe(true);

      const envResult = analyzeShellCommand('env $FLAGS', parser);
      expect(envResult.unanalyzable).toBe(true);
    });
  });
});
