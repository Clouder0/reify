import { spawn } from "node:child_process";

export type RipgrepJsonEvent = {
  type: string;
  data?: unknown;
};

export type RunRipgrepJsonOptions = {
  cwd: string;
  rgPath: string;
  args: string[];
  timeoutMs: number;
  onEvent: (event: RipgrepJsonEvent) => boolean | void;
  env?: NodeJS.ProcessEnv;
  maxJsonLineBytes?: number;
  maxStderrBytes?: number;
  maxParseErrors?: number;
};

export type RunRipgrepJsonResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
  outputTooLarge: boolean;
  stderr: string;
  parseErrors: string[];
};

const DEFAULT_MAX_JSON_LINE_BYTES = 2 * 1024 * 1024;

export async function runRipgrepJson({
  cwd,
  rgPath,
  args,
  timeoutMs,
  onEvent,
  env,
  maxJsonLineBytes,
  maxStderrBytes,
  maxParseErrors,
}: RunRipgrepJsonOptions): Promise<RunRipgrepJsonResult> {
  const stderrByteLimit = maxStderrBytes ?? 32 * 1024;
  const parseErrorLimit = maxParseErrors ?? 20;
  const jsonLineByteLimit = maxJsonLineBytes ?? DEFAULT_MAX_JSON_LINE_BYTES;

  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be an integer > 0");
  }
  if (
    !Number.isFinite(jsonLineByteLimit) ||
    !Number.isInteger(jsonLineByteLimit) ||
    jsonLineByteLimit <= 0
  ) {
    throw new TypeError("maxJsonLineBytes must be an integer > 0");
  }
  if (!Number.isFinite(stderrByteLimit) || !Number.isInteger(stderrByteLimit) || stderrByteLimit < 0) {
    throw new TypeError("maxStderrBytes must be an integer >= 0");
  }
  if (!Number.isFinite(parseErrorLimit) || !Number.isInteger(parseErrorLimit) || parseErrorLimit < 0) {
    throw new TypeError("maxParseErrors must be an integer >= 0");
  }

  const mergedEnv: NodeJS.ProcessEnv | undefined =
    env === undefined
      ? undefined
      : (() => {
          // `child_process.spawn` treats the provided `env` as the *entire*
          // environment. Callers typically want to tweak a variable without
          // dropping everything else, so we treat `env` as overrides.
          const out: NodeJS.ProcessEnv = { ...process.env };
          const caseInsensitive = process.platform === "win32";

          for (const [key, value] of Object.entries(env)) {
            if (caseInsensitive) {
              const upper = key.toUpperCase();
              for (const existingKey of Object.keys(out)) {
                if (existingKey.toUpperCase() === upper) {
                  delete out[existingKey];
                }
              }
            }

            if (value === undefined) {
              delete out[key];
            } else {
              out[key] = value;
            }
          }
          return out;
        })();

  return await new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(rgPath, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: useProcessGroup,
      ...(mergedEnv ? { env: mergedEnv } : {}),
    });

    const killChild = (signal: NodeJS.Signals) => {
      try {
        if (useProcessGroup && typeof child.pid === "number") {
          // Kill the entire process group to avoid orphaned grandchildren when
          // `rgPath` is a wrapper script.
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // ignore
      }
    };

    const decoder = new TextDecoder("utf-8");
    let pendingParts: Buffer[] = [];
    let pendingLen = 0;
    let stderrBuf = "";
    let stderrBytes = 0;
    const parseErrors: string[] = [];

    let done = false;
    let timedOut = false;
    let killed = false;
    let outputTooLarge = false;
    let stopRequested = false;
    let hardKillTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let forceResolveTimer: NodeJS.Timeout | null = null;

    type StopReason = "timeout" | "handler" | "outputTooLarge";
    let stopReason: StopReason | null = null;

    const forceResolve = (note: string) => {
      if (done) return;
      done = true;

      if (parseErrors.length < parseErrorLimit) {
        parseErrors.push(note);
      }

      // Best-effort teardown so callers don't hang waiting for process exit.
      killChild("SIGKILL");
      try {
        child.stdout?.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr?.destroy();
      } catch {
        // ignore
      }
      try {
        child.unref();
      } catch {
        // ignore
      }

      cleanup();
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        killed,
        outputTooLarge,
        stderr: stderrBuf,
        parseErrors,
      });
    };

    const requestStop = (reason: StopReason) => {
      if (done || stopRequested) return;
      stopRequested = true;
      stopReason ??= reason;
      killed = true;

      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      killChild("SIGTERM");

      // Escalate if needed to avoid lingering processes.
      hardKillTimer = setTimeout(() => {
        killChild("SIGKILL");
      }, 500);

      // Even after SIGKILL, some environments can prevent the child from
      // exiting (e.g. uninterruptible I/O). Ensure the promise settles.
      forceResolveTimer = setTimeout(() => {
        const why = stopReason === "timeout" ? `rg did not exit after timing out (${timeoutMs}ms)` : "rg did not exit after stop request";
        forceResolve(why);
      }, 2_000);
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestStop("timeout");
    }, timeoutMs);

    const cleanup = () => {
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceResolveTimer) clearTimeout(forceResolveTimer);
    };

    child.on("error", (err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    });

    child.stdout?.on("error", (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      forceResolve(`rg stdout error: ${msg}`);
    });

    child.stderr?.on("error", (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      forceResolve(`rg stderr error: ${msg}`);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (done || stopRequested) return;

      let start = 0;
      while (!stopRequested) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl < 0) break;

        const part = chunk.subarray(start, nl);
        const lineLen = pendingLen + part.length;
        if (lineLen > jsonLineByteLimit) {
          outputTooLarge = true;
          requestStop("outputTooLarge");
          return;
        }

        const lineBytes = pendingLen === 0 ? part : Buffer.concat([...pendingParts, part], lineLen);
        pendingParts = [];
        pendingLen = 0;

        let slice = lineBytes;
        if (slice.length > 0 && slice[slice.length - 1] === 0x0d) {
          slice = slice.subarray(0, slice.length - 1);
        }
        if (slice.length > 0) {
          const line = decoder.decode(slice);
          if (line.trim().length > 0) {
            let obj: RipgrepJsonEvent;
            try {
              obj = JSON.parse(line) as RipgrepJsonEvent;
            } catch (e) {
              if (parseErrors.length < parseErrorLimit) {
                const msg = e instanceof Error ? e.message : String(e);
                parseErrors.push(`rg --json parse error: ${msg}`);
              }
              start = nl + 1;
              continue;
            }

            try {
                const shouldStop = onEvent(obj);
                if (shouldStop === true) {
                  requestStop("handler");
                  return;
                }
              } catch (e) {
              if (parseErrors.length < parseErrorLimit) {
                const msg = e instanceof Error ? e.message : String(e);
                parseErrors.push(`rg --json handler error: ${msg}`);
              }
            }
          }
        }

        start = nl + 1;
      }

      if (stopRequested) return;

      const tail = chunk.subarray(start);
      if (tail.length > 0) {
        const nextLen = pendingLen + tail.length;
        if (nextLen > jsonLineByteLimit) {
          outputTooLarge = true;
          requestStop("outputTooLarge");
          return;
        }

        pendingParts.push(tail);
        pendingLen = nextLen;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (done) return;
      if (stderrBytes >= stderrByteLimit) return;
      const remaining = stderrByteLimit - stderrBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrBuf += slice.toString("utf8");
      stderrBytes += slice.length;
    });

    child.on("close", (exitCode, signal) => {
      if (done) return;
      done = true;
      cleanup();

      // Flush any remaining decoded data if we weren't stopped early.
      if (!stopRequested) {
        if (pendingLen > 0) {
          const pending = Buffer.concat(pendingParts, pendingLen);
          let slice = pending;
          if (slice.length > 0 && slice[slice.length - 1] === 0x0d) {
            slice = slice.subarray(0, slice.length - 1);
          }

          const line = decoder.decode(slice);
          const tail = line.trim();
          if (tail.length > 0) {
            // rg normally terminates each JSON object with a newline; this is a best-effort fallback.
            try {
              const obj = JSON.parse(tail) as RipgrepJsonEvent;
              try {
                onEvent(obj);
              } catch {
                // ignore
              }
            } catch {
              // ignore
            }
          }
        }
      }

      resolve({
        exitCode,
        signal: signal as NodeJS.Signals | null,
        timedOut,
        killed,
        outputTooLarge,
        stderr: stderrBuf,
        parseErrors,
      });
    });
  });
}
