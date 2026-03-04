import { afterEach, expect, test } from "bun:test";

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { __testing, resolveAuthToken } from "../src/kits/github/internal/client";

function withEnv(mut: Record<string, string | null>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(mut)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(mut)) {
      if (v === null) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const createdTmpDirs: string[] = [];
const prevPath = process.env.PATH ?? "";

function prefixedPath(stubDir: string): string {
  return prevPath.length === 0 ? stubDir : `${stubDir}${delimiter}${prevPath}`;
}

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  createdTmpDirs.push(dir);
  return dir;
}

function installStubGh(opts: { logPath: string; token: string }): string {
  const dir = mkTmp("reify-gh-stub-");

  // Use a tiny Bun script so tests don't depend on /bin/bash.
  // It logs argv (excluding the executable) and prints the configured token.
  const unix = join(dir, "gh");
  const unixScript = [
    "#!/usr/bin/env bun",
    "import { appendFileSync } from \"node:fs\";",
    `appendFileSync(${JSON.stringify(opts.logPath)}, process.argv.slice(2).join(\" \" ) + \"\\n\", \"utf8\");`,
    `process.stdout.write(${JSON.stringify(opts.token)});`,
    "",
  ].join("\n");
  writeFileSync(unix, unixScript, "utf8");
  try {
    chmodSync(unix, 0o755);
  } catch {
    // Best-effort; some environments may not support chmod.
  }

  // On Windows, Node's spawn search will usually find gh.cmd via PATHEXT.
  const win = join(dir, "gh.cmd");
  const winScript = [
    "@echo off",
    `bun ${JSON.stringify(unix)} %*`,
    "",
  ].join("\r\n");
  writeFileSync(win, winScript, "utf8");

  return dir;
}

afterEach(() => {
  process.env.PATH = prevPath;
  __testing.resetGhTokenCache();

  for (const dir of createdTmpDirs.splice(0, createdTmpDirs.length)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

test("resolveAuthToken: explicit authToken wins (does not call gh)", () => {
  withEnv(
    {
      GITHUB_TOKEN: "env_github",
      GH_TOKEN: "env_gh",
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken("explicit_token", { restBaseUrl: "https://api.github.com" });
      expect(out).toBe("explicit_token");
      expect(existsSync(logPath)).toBe(false);
    },
  );
});

test("resolveAuthToken: GITHUB_TOKEN wins over GH_TOKEN and gh", () => {
  withEnv(
    {
      GITHUB_TOKEN: "env_github",
      GH_TOKEN: "env_gh",
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken(undefined, { restBaseUrl: "https://api.github.com" });
      expect(out).toBe("env_github");
      expect(existsSync(logPath)).toBe(false);
    },
  );
});

test("resolveAuthToken: GH_TOKEN is used if GITHUB_TOKEN is missing", () => {
  withEnv(
    {
      GITHUB_TOKEN: null,
      GH_TOKEN: "env_gh",
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken(undefined, { restBaseUrl: "https://api.github.com" });
      expect(out).toBe("env_gh");
      expect(existsSync(logPath)).toBe(false);
    },
  );
});

test("resolveAuthToken: falls back to gh auth token when no env token exists", () => {
  withEnv(
    {
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token_123" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken(undefined, { restBaseUrl: "https://api.github.com" });
      expect(out).toBe("gh_token_123");

      const args = readFileSync(logPath, "utf8");
      expect(args).toContain("auth token");
      expect(args).toContain("--hostname github.com");
    },
  );
});

test("resolveAuthToken: successful gh token is cached per process", () => {
  withEnv(
    {
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token_cached" });
      process.env.PATH = prefixedPath(stubDir);

      const a = resolveAuthToken(undefined, { restBaseUrl: "https://api.github.com" });
      const b = resolveAuthToken(undefined, { restBaseUrl: "https://api.github.com" });
      expect(a).toBe("gh_token_cached");
      expect(b).toBe("gh_token_cached");

      const calls = readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      expect(calls.length).toBe(1);
    },
  );
});

test("resolveAuthToken: disable flag prevents gh fallback", () => {
  withEnv(
    {
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      REIFY_GITHUB_DISABLE_GH: "1",
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken(undefined, { restBaseUrl: "https://api.github.com" });
      expect(out).toBeUndefined();
      expect(existsSync(logPath)).toBe(false);
    },
  );
});

test("resolveAuthToken: skips gh fallback for loopback hosts", () => {
  withEnv(
    {
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "gh_token" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken(undefined, { restBaseUrl: "http://127.0.0.1:12345" });
      expect(out).toBeUndefined();
      expect(existsSync(logPath)).toBe(false);
    },
  );
});

test("resolveAuthToken: does not use gh for non-github.com restBaseUrl", () => {
  withEnv(
    {
      GITHUB_TOKEN: null,
      GH_TOKEN: null,
      REIFY_GITHUB_DISABLE_GH: null,
    },
    () => {
      const logPath = join(mkTmp("reify-gh-log-"), "args.txt");
      const stubDir = installStubGh({ logPath, token: "ghes_token" });
      process.env.PATH = prefixedPath(stubDir);

      const out = resolveAuthToken(undefined, { restBaseUrl: "https://ghe.example.com/api/v3" });
      expect(out).toBeUndefined();
      expect(existsSync(logPath)).toBe(false);
    },
  );
});
