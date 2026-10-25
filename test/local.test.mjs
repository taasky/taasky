// Local mode: /mcp stays keyless whatever token a client still sends.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dropStaleToken } from "../src/local.ts";

const auth = () => new Headers({ authorization: "Bearer from-an-earlier-node" });

test("local mode drops a token on /mcp", () => {
  const h = auth();
  dropStaleToken("/mcp", h, true);
  assert.equal(h.has("authorization"), false);
});

test("local mode keeps it on /mcp/account", () => {
  const h = auth();
  dropStaleToken("/mcp/account", h, true);
  assert.equal(h.get("authorization"), "Bearer from-an-earlier-node");
});

test("a shared node keeps it everywhere", () => {
  const h = auth();
  dropStaleToken("/mcp", h, false);
  assert.equal(h.get("authorization"), "Bearer from-an-earlier-node");
});
