import { expect, test } from "bun:test";

import * as reify from "../src/index";

test("bootstrap is not part of the public API", () => {
  expect("bootstrap" in reify).toBe(false);
});

test("global ref inspection API is not part of the public API", () => {
  expect("inspect" in reify).toBe(false);
});
