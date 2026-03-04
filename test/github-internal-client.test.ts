import { expect, test } from "bun:test";

import { __testing, createGithubClients } from "../src/kits/github/internal/client";

test("__testing.withTestRestBaseUrl overrides REST base URL for tests", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/hello") {
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const baseUrl = `http://${server.hostname}:${server.port}`;

  try {
    expect(typeof (__testing as any).withTestRestBaseUrl).toBe("function");

    const data = await (__testing as any).withTestRestBaseUrl(baseUrl, async () => {
      const { rest } = createGithubClients({});
      const res = await rest.request("GET /hello");
      return res.data;
    });

    expect(data).toEqual({ ok: true });
  } finally {
    server.stop(true);
  }
});

test("__testing.withTestRestBaseUrl rejects non-loopback URLs", () => {
  expect(typeof (__testing as any).withTestRestBaseUrl).toBe("function");
  expect(() => (__testing as any).withTestRestBaseUrl("https://api.github.com", () => {})).toThrow();
});
