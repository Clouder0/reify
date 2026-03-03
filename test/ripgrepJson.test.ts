import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runRipgrepJson } from "../src/kits/fs/_ripgrepJson";

async function pidExited(pid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === "ESRCH") return true;
      // EPERM means it exists but we can't signal it (shouldn't happen in tests).
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

test("runRipgrepJson merges provided env with process.env", async () => {
  // Extremely defensive: this should basically always exist.
  const inheritedPath = process.env.PATH ?? (process.env as Record<string, string | undefined>).Path;
  if (!inheritedPath) return;

  const dir = join(process.cwd(), ".tmp-reify-runRipgrepJson-env-merge");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });

    const scriptPath = join(dir, "fake-rg.js");
    await writeFile(
      scriptPath,
      [
        "const hasPath = typeof process.env.PATH === 'string' || typeof process.env.Path === 'string';",
        "if (!hasPath) {",
        "  process.stderr.write('missing PATH\\n');",
        "  process.exit(2);",
        "}",
        "process.stdout.write(JSON.stringify({ type: 'match', data: {} }) + '\\n');",
        "",
      ].join("\n"),
      "utf8",
    );

    const eventTypes: string[] = [];
    const result = await runRipgrepJson({
      cwd: dir,
      rgPath: process.execPath,
      args: [scriptPath],
      timeoutMs: 5_000,
      onEvent: (event) => {
        if (typeof event.type === "string") eventTypes.push(event.type);
      },
      // Intentionally *not* a full env; should merge with `process.env`.
      env: { REIFY_TEST_ENV_MERGE: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(eventTypes).toContain("match");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRipgrepJson does not mark timedOut when stopped early", async () => {
  const dir = join(process.cwd(), ".tmp-reify-runRipgrepJson-early-stop");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });

    const scriptPath = join(dir, "fake-rg-stop-slow.js");
    await writeFile(
      scriptPath,
      [
        "process.on('SIGTERM', () => {",
        "  // Simulate slow termination so the timeout timer can fire.",
        "  setTimeout(() => process.exit(0), 200);",
        "});",
        "process.stdout.write(JSON.stringify({ type: 'match', data: {} }) + '\\n');",
        "setInterval(() => {}, 1_000);",
        "",
      ].join("\n"),
      "utf8",
    );

    const eventTypes: string[] = [];
    const result = await runRipgrepJson({
      cwd: dir,
      rgPath: process.execPath,
      args: [scriptPath],
      // Intentionally shorter than the SIGTERM->exit delay above.
      timeoutMs: 50,
      onEvent: (event) => {
        if (typeof event.type === "string") eventTypes.push(event.type);
        return true;
      },
    });

    expect(eventTypes).toContain("match");
    expect(result.killed).toBe(true);
    expect(result.timedOut).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runRipgrepJson kills the process group (no orphan grandchildren)", async () => {
  if (process.platform === "win32") return;

  const dir = join(process.cwd(), ".tmp-reify-runRipgrepJson-process-group");
  await rm(dir, { recursive: true, force: true });

  let grandchildPid: number | null = null;
  try {
    await mkdir(dir, { recursive: true });

    const grandchildScriptPath = join(dir, "grandchild.js");
    await writeFile(grandchildScriptPath, "setInterval(() => {}, 1000);\n", "utf8");

    const pidFilePath = join(dir, "grandchild.pid");
    const wrapperScriptPath = join(dir, "wrapper.js");
    await writeFile(
      wrapperScriptPath,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const pidFile = process.argv[2];",
        "const childScript = process.argv[3];",
        "const child = spawn(process.execPath, [childScript], { stdio: 'ignore' });",
        "writeFileSync(pidFile, String(child.pid), 'utf8');",
        "process.stdout.write(JSON.stringify({ type: 'match', data: {} }) + '\\n');",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf8",
    );

    await runRipgrepJson({
      cwd: dir,
      rgPath: process.execPath,
      args: [wrapperScriptPath, pidFilePath, grandchildScriptPath],
      timeoutMs: 5_000,
      onEvent: () => true,
    });

    const pidText = await readFile(pidFilePath, "utf8");
    grandchildPid = Number.parseInt(pidText.trim(), 10);
    expect(Number.isFinite(grandchildPid)).toBe(true);
    if (!grandchildPid || !Number.isFinite(grandchildPid)) {
      throw new Error("grandchild pid missing");
    }

    expect(await pidExited(grandchildPid, 2_000)).toBe(true);
  } finally {
    if (grandchildPid && Number.isFinite(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});
