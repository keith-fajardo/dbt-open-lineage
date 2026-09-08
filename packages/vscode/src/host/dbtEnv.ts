import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/** Parse the null-delimited output of `env -0`, ignoring shell banners/noise. */
export function parseNullEnvironment(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const rawEntry of output.split("\0")) {
    // Interactive shell startup files may print a banner before `env -0`.
    // Only the final line can be an actual KEY=VALUE entry in that segment.
    const entry = rawEntry.split(/\r?\n/).pop() ?? "";
    const i = entry.indexOf("=");
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return env;
}

/** Parse one KEY=VALUE entry per line, as emitted by PowerShell. */
export function parseLineEnvironment(output: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function parseDotEnv(contents: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[match[1]] = value;
  }
  return env;
}

type ShellCommand = { file: string; args: string[]; parse: (output: string) => NodeJS.ProcessEnv };

function shellCandidates(platform: NodeJS.Platform, baseEnv: NodeJS.ProcessEnv): ShellCommand[] {
  if (platform === "win32") {
    const programFiles = baseEnv.ProgramW6432 || baseEnv.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = baseEnv["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const bash = (file: string): ShellCommand => ({ file, args: ["-ilc", "env -0"], parse: parseNullEnvironment });
    const powershell = (file: string): ShellCommand => ({
      file,
      args: ["-NoLogo", "-Command", "[Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value }"],
      parse: parseLineEnvironment,
    });
    return [
      bash("bash.exe"),
      bash(path.join(programFiles, "Git", "bin", "bash.exe")),
      bash(path.join(programFilesX86, "Git", "bin", "bash.exe")),
      powershell("pwsh.exe"),
      powershell("powershell.exe"),
    ];
  }
  return [{
    file: baseEnv.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
    args: ["-ilc", "env -0"],
    parse: parseNullEnvironment,
  }];
}

const shellEnvironmentCache = new Map<string, NodeJS.ProcessEnv>();

/** Capture variables from the user's interactive login shell. This is what
 * makes GUI-launched VS Code see values configured in Git Bash ~/.bashrc,
 * macOS ~/.zshrc, or a Linux shell profile. Failures are intentionally silent:
 * the inherited process environment and project .env remain valid fallbacks. */
export function discoverLoginShellEnvironment(
  platform: NodeJS.Platform = process.platform,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const cacheKey = `${platform}:${baseEnv.SHELL ?? ""}:${baseEnv.ProgramFiles ?? ""}`;
  const cached = shellEnvironmentCache.get(cacheKey);
  if (cached) return cached;
  for (const shell of shellCandidates(platform, baseEnv)) {
    try {
      const output = execFileSync(shell.file, shell.args, {
        env: baseEnv,
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const discovered = shell.parse(output as string);
      shellEnvironmentCache.set(cacheKey, discovered);
      return discovered;
    } catch { /* try the next shell candidate */ }
  }
  shellEnvironmentCache.set(cacheKey, {});
  return {};
}

/** Resolve dbt's environment with predictable precedence: inherited VS Code
 * variables win, then the user's login shell, then project .env files. */
export function resolveDbtEnvironment(projectRoot?: string): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  const shell = discoverLoginShellEnvironment(process.platform, inherited);
  const files: NodeJS.ProcessEnv = {};
  if (projectRoot) {
    for (const name of [".env", ".env.local"]) {
      try { Object.assign(files, parseDotEnv(fs.readFileSync(path.join(projectRoot, name), "utf8"))); }
      catch { /* optional */ }
    }
  }
  return { ...files, ...shell, ...inherited };
}
