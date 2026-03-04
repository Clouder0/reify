import { Octokit } from "@octokit/core";

import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

export type GithubClientOptions = {
  authToken?: string;
};

export type GithubClients = {
  // Keep the public surface typed via ArkType schemas; internally we keep Octokit types loose
  // to avoid coupling to Octokit generics.
  rest: any;
};

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

const testRestBaseUrl = new AsyncLocalStorage<string>();

function testRestBaseUrlOverride(): string | null {
  return testRestBaseUrl.getStore() ?? null;
}

function shouldAttemptGhAuth(restBaseUrl: string): boolean {
  const u = tryParseUrl(restBaseUrl);
  if (!u) return false;

  // Avoid repeatedly spawning `gh` when running against a local fixture server.
  if (isLoopbackHostname(u.hostname)) return false;

  // This kit intentionally supports GitHub.com only.
  return u.hostname === "api.github.com" || u.hostname === "github.com";
}

let ghMissing = false;
let ghTokenCache: string | null = null;

function tryGetGhAuthToken(restBaseUrl: string): string | undefined {
  if (process.env.REIFY_GITHUB_DISABLE_GH === "1") return undefined;
  if (ghMissing) return undefined;

  if (!shouldAttemptGhAuth(restBaseUrl)) return undefined;

  if (ghTokenCache) return ghTokenCache;

  const args = ["auth", "token", "--hostname", "github.com"];
  try {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Bun's node:child_process shim does not reliably observe mutations to
      // process.env unless we pass an explicit env object.
      env: { ...process.env },
      timeout: 2000,
      maxBuffer: 256 * 1024,
    });

    const token = typeof stdout === "string" ? stdout.trim() : "";
    if (token.length === 0) return undefined;
    ghTokenCache = token;
    return token;
  } catch (err) {
    // If gh isn't installed, don't try again this process.
    if (err && typeof err === "object" && "code" in err && (err as any).code === "ENOENT") {
      ghMissing = true;
    }
    return undefined;
  }
}

export const __testing = {
  resetGhTokenCache() {
    ghMissing = false;
    ghTokenCache = null;
  },
  withTestRestBaseUrl<T>(url: string, fn: () => T): T {
    const parsed = tryParseUrl(url);
    if (!parsed || !isLoopbackHostname(parsed.hostname)) {
      throw new TypeError("Test REST base URL must be a loopback URL");
    }

    return testRestBaseUrl.run(stripTrailingSlashes(url), fn);
  },
};

export function resolveAuthToken(
  explicit: string | undefined,
  opts?: {
    restBaseUrl?: string;
  },
): string | undefined {
  const exp = typeof explicit === "string" ? explicit.trim() : "";
  if (exp.length > 0) return exp;

  const envGithub = typeof process.env.GITHUB_TOKEN === "string" ? process.env.GITHUB_TOKEN.trim() : "";
  if (envGithub.length > 0) return envGithub;

  const envGh = typeof process.env.GH_TOKEN === "string" ? process.env.GH_TOKEN.trim() : "";
  if (envGh.length > 0) return envGh;

  const restBaseUrl = opts?.restBaseUrl ?? "https://api.github.com";
  return tryGetGhAuthToken(restBaseUrl);
}

export function createGithubClients(opts: GithubClientOptions): GithubClients {
  const restBaseUrl = testRestBaseUrlOverride() ?? "https://api.github.com";

  const authToken = resolveAuthToken(opts.authToken, { restBaseUrl });
  const auth = authToken ? { auth: authToken } : {};

  return {
    rest: new Octokit({
      ...auth,
      baseUrl: restBaseUrl,
      request: {
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    }) as any,
  };
}
