/**
 * On Windows OpenCode runs shell commands in Windows PowerShell 5.1, which
 * writes its own messages in the console code page (GBK on a Chinese system)
 * while OpenCode reads the output as UTF-8. Every Chinese error message, path
 * or file name then reaches the model as "D:\��Ԫϵͳ" and it cannot read its
 * own failures. Switching the console to UTF-8 at the start of each command
 * fixes that without changing the shell the skills are written for.
 */

export const UTF8_CONSOLE_PREFIX =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
  + '$OutputEncoding = [Console]::OutputEncoding; ';

type ToolBeforeInput = { tool: string };
type ToolBeforeOutput = { args: Record<string, unknown> };

/** OpenCode picks a POSIX shell on Windows only when SHELL names one. */
export function runsInPowerShell(platform: string, shellEnv: string | undefined): boolean {
  if (platform !== 'win32') return false;
  const shell = String(shellEnv || '').trim().toLowerCase();
  if (!shell) return true;
  return /(^|[\\/])(pwsh|powershell)(\.exe)?$/.test(shell);
}

export function withUtf8Console(command: string): string {
  if (!command.trim() || command.includes('[Console]::OutputEncoding')) return command;
  return UTF8_CONSOLE_PREFIX + command;
}

export function createPowerShellUtf8Plugin() {
  return async () => ({
    'tool.execute.before': async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
      if (input.tool !== 'bash') return;
      if (!runsInPowerShell(process.platform, process.env.SHELL)) return;
      const command = output.args.command;
      if (typeof command === 'string') output.args.command = withUtf8Console(command);
    }
  });
}
