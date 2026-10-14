import { afterEach, describe, expect, it } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';

const originalTodoFlag = process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;

afterEach(() => {
  if (originalTodoFlag === undefined) delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
  else process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = originalTodoFlag;
});

describe('buildClaudeSubprocessEnv', () => {
  it('applies the 70 percent compaction policy to SDK sessions before launch', () => {
    const env = buildClaudeSubprocessEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '98', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' });
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('70');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
  });
  it('keeps the task-tracking tools available on every model (SDK 0.3.268 default change)', () => {
    delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
  });

  it('respects an explicit opt-out from the process environment', () => {
    process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '0';
    expect(buildClaudeSubprocessEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0');
  });

  it('respects a per-session override', () => {
    delete process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS;
    expect(buildClaudeSubprocessEnv({ CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0');
  });
});
