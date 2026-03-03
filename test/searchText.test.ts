import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as fsKit from "../src/kits/fs/index";

function requireSearchText(): any {
  const fn = (fsKit as any).searchText;
  expect(typeof fn).toBe("function");
  return fn;
}

async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix));
}

async function writeFixture(root: string): Promise<void> {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.txt"), "hello pattern\n", "utf8");
  await writeFile(join(root, "src", "b.txt"), "nope\n", "utf8");
  await writeFile(join(root, ".hidden.txt"), "pattern\n", "utf8");
  await writeFile(join(root, "ignored.txt"), "pattern\n", "utf8");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    prev[key] = process.env[key];
  }

  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("searchText returns bounded matches grouped by file", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-basic");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern", maxMatches: 10 });

    expect(out.pattern).toBe("pattern");
    expect(out.truncated).toBe(false);
    expect(out.files.length).toBeGreaterThan(0);
    expect(out.files.every((f: any) => typeof f.path === "string")).toBe(true);
    // Deterministic ordering: paths are sorted.
    const paths = out.files.map((f: any) => f.path);
    expect(paths.slice().sort()).toEqual(paths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText respects ignore files by default", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-ignore-default");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern" });

    expect(out.files.some((f: any) => f.path.endsWith("ignored.txt"))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText can disable ignore files", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-ignore-disabled");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern", respectIgnore: false });

    expect(out.files.some((f: any) => f.path.endsWith("ignored.txt"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText default ignorePolicy is scoped (does not read parent .ignore)", async () => {
  const base = await makeTempDir("reify-searchText-ignorePolicy-parent-");
  const parent = join(base, "parent");
  const root = join(parent, "root");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "pattern\n", "utf8");
    await writeFile(join(parent, ".ignore"), "a.txt\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: root, pattern: "pattern" });

    expect(out.files.some((f: any) => f.path.endsWith("a.txt"))).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("searchText ignorePolicy=rg uses parent .ignore", async () => {
  const base = await makeTempDir("reify-searchText-ignorePolicy-parent-rg-");
  const parent = join(base, "parent");
  const root = join(parent, "root");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "pattern\n", "utf8");
    await writeFile(join(parent, ".ignore"), "a.txt\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: root, pattern: "pattern", ignorePolicy: "rg" });

    expect(out.files.some((f: any) => f.path.endsWith("a.txt"))).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  test.skip("searchText ignorePolicy tests using global gitignore", () => {});
} else {
  test("searchText default ignorePolicy is scoped (does not use global gitignore)", async () => {
    const base = await makeTempDir("reify-searchText-ignorePolicy-global-");
    try {
      const home = join(base, "home");
      const xdgConfigHome = join(home, ".config");
      await mkdir(join(xdgConfigHome, "git"), { recursive: true });
      await writeFile(join(xdgConfigHome, "git", "ignore"), "a.txt\n", "utf8");

      const root = join(base, "root");
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, "a.txt"), "pattern\n", "utf8");

      const searchText = requireSearchText();
      const out = await withEnv(
        {
          HOME: home,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        async () => await searchText({ path: root, pattern: "pattern" }),
      );

      expect(out.files.some((f: any) => f.path.endsWith("a.txt"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("searchText ignorePolicy=rg respects global gitignore", async () => {
    const base = await makeTempDir("reify-searchText-ignorePolicy-global-rg-");
    try {
      const home = join(base, "home");
      const xdgConfigHome = join(home, ".config");
      await mkdir(join(xdgConfigHome, "git"), { recursive: true });
      await writeFile(join(xdgConfigHome, "git", "ignore"), "a.txt\n", "utf8");

      const root = join(base, "root");
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, "a.txt"), "pattern\n", "utf8");

      const searchText = requireSearchText();
      const out = await withEnv(
        {
          HOME: home,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        async () =>
          await searchText({
            path: root,
            pattern: "pattern",
            ignorePolicy: "rg",
          }),
      );

      expect(out.files.some((f: any) => f.path.endsWith("a.txt"))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
}

test("searchText default ignorePolicy is scoped (does not use .git/info/exclude)", async () => {
  const base = await makeTempDir("reify-searchText-ignorePolicy-exclude-");
  try {
    const root = join(base, "root");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "a.txt\n", "utf8");
    await writeFile(join(root, "a.txt"), "pattern\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: root, pattern: "pattern" });

    expect(out.files.some((f: any) => f.path.endsWith("a.txt"))).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("searchText ignorePolicy=rg respects .git/info/exclude", async () => {
  const base = await makeTempDir("reify-searchText-ignorePolicy-exclude-rg-");
  try {
    const root = join(base, "root");
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await writeFile(join(root, ".git", "info", "exclude"), "a.txt\n", "utf8");
    await writeFile(join(root, "a.txt"), "pattern\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: root, pattern: "pattern", ignorePolicy: "rg" });

    expect(out.files.some((f: any) => f.path.endsWith("a.txt"))).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("searchText default ignorePolicy is scoped (applies .gitignore even outside a git repo)", async () => {
  const base = await makeTempDir("reify-searchText-ignorePolicy-no-require-git-");
  try {
    const root = join(base, "root");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "pattern\n", "utf8");
    await writeFile(join(root, "kept.txt"), "pattern\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: root, pattern: "pattern" });

    expect(out.files.some((f: any) => f.path.endsWith("kept.txt"))).toBe(true);
    expect(out.files.some((f: any) => f.path.endsWith("ignored.txt"))).toBe(false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("searchText ignorePolicy=rg does not apply .gitignore outside a git repo", async () => {
  const base = await makeTempDir("reify-searchText-ignorePolicy-no-require-git-rg-");
  try {
    const root = join(base, "root");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
    await writeFile(join(root, "ignored.txt"), "pattern\n", "utf8");
    await writeFile(join(root, "kept.txt"), "pattern\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: root, pattern: "pattern", ignorePolicy: "rg" });

    expect(out.files.some((f: any) => f.path.endsWith("ignored.txt"))).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("searchText searches hidden files by default", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-hidden");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern" });

    expect(out.files.some((f: any) => f.path.endsWith(".hidden.txt"))).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText enforces maxMatches budget", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-budget");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern", maxMatches: 1 });

    const total = out.files.reduce((n: number, f: any) => n + f.matches.length, 0);
    expect(total).toBe(1);
    expect(out.truncated).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText ignores ripgrep config (RIPGREP_CONFIG_PATH)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-no-config");
  await rm(dir, { recursive: true, force: true });
  const prev = process.env.RIPGREP_CONFIG_PATH;
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    // If rg reads this config, it will stop respecting .gitignore.
    const cfgPath = join(dir, "rg.conf");
    await writeFile(cfgPath, "--no-ignore\n", "utf8");
    process.env.RIPGREP_CONFIG_PATH = cfgPath;

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern" });

    expect(out.files.some((f: any) => f.path.endsWith("ignored.txt"))).toBe(false);
  } finally {
    if (prev === undefined) {
      delete process.env.RIPGREP_CONFIG_PATH;
    } else {
      process.env.RIPGREP_CONFIG_PATH = prev;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText does not include submatch text payloads", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-submatches");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern" });

    const first = out.files.flatMap((f: any) => f.matches)[0];
    expect(first).toBeTruthy();
    expect(Array.isArray(first.submatches)).toBe(true);
    expect(first.submatches.length).toBeGreaterThan(0);
    expect("match" in first.submatches[0]).toBe(false);
    expect(typeof first.submatches[0].startByte).toBe("number");
    expect(typeof first.submatches[0].endByte).toBe("number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText escapes terminal control characters in previews", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-preview-escape");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });

    // Include an ANSI escape sequence that would change terminal rendering if
    // printed raw.
    const esc = "\x1b";
    await writeFile(join(dir, "a.txt"), `hello ${esc}[31mpattern${esc}[0m\n`, "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern" });

    const first = out.files.flatMap((f: any) => f.matches)[0];
    expect(first).toBeTruthy();
    expect(first.preview.includes("\x1b")).toBe(false);
    expect(first.preview).toContain("\\x1b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText does not split escape sequences when truncating previews", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-preview-truncate-escape");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });

    // Escape sequence at the start so truncation can bisect it.
    const esc = "\x1b";
    await writeFile(join(dir, "a.txt"), `${esc}[31mpattern${esc}[0m\n`, "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern", maxPreviewChars: 2 });

    const first = out.files.flatMap((f: any) => f.matches)[0];
    expect(first).toBeTruthy();
    expect(first.preview.includes("\x1b")).toBe(false);
    expect(first.preview).toBe("<<<REIFY_LINE_TRUNCATED>>>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText returns an escaped displayPath for safe printing", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-displayPath");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });

    const esc = "\x1b";
    const fileName = `a${esc}b.txt`;
    await writeFile(join(dir, fileName), "pattern\n", "utf8");

    const searchText = requireSearchText();
    const out = await searchText({ path: dir, pattern: "pattern" });

    const file = out.files.find((f: any) => typeof f.path === "string" && f.path.includes(esc));
    expect(file).toBeTruthy();
    expect(typeof file.displayPath).toBe("string");
    expect(file.displayPath.includes(esc)).toBe(false);
    expect(file.displayPath).toContain("\\x1b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText stops when rg emits an oversized JSON record", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-oversize-json");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const out = await searchText({
      path: dir,
      pattern: "pattern",
      // Intentionally tiny to force the guardrail.
      maxRgJsonLineBytes: 200,
    });

    expect(out.truncated).toBe(true);
    expect(out.errors.join("\n").toLowerCase()).toContain("oversized");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("searchText returns structured errors on invalid pattern (fatal rg error)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-invalid-pattern");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFixture(dir);

    const searchText = requireSearchText();
    const result = await searchText({ path: dir, pattern: "(" });

    expect(result.files.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/regex|parse/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  test.skip("searchText allows filenames beginning with '..\\' on POSIX", () => {});
} else {
  test("searchText allows filenames beginning with '..\\' on POSIX", async () => {
    const dir = join(process.cwd(), ".tmp-reify-searchText-dotdot-backslash-posix");
    await rm(dir, { recursive: true, force: true });
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "..\\weird.txt"), "pattern\n", "utf8");

      const searchText = requireSearchText();
      const out = await searchText({ path: dir, pattern: "pattern" });

      expect(out.files.some((f: any) => f.path.endsWith("..\\weird.txt"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("searchText returns structured errors on nonexistent path", async () => {
  const searchText = requireSearchText();
  const result = await searchText({ path: "/nonexistent-path-xyz-123", pattern: "test" });

  expect(result.files.length).toBe(0);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]).toMatch(/no such file|not found|cannot/i);
});

test("searchText returns structured errors when path is not a directory", async () => {
  const dir = join(process.cwd(), ".tmp-reify-searchText-not-dir");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "file.txt"), "pattern\n", "utf8");

    const searchText = requireSearchText();
    const result = await searchText({ path: join(dir, "file.txt"), pattern: "test" });

    expect(result.files.length).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("directory");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
