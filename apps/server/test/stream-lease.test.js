import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { renewThreadLease, subscribe } from "../src/server.js";

test("silent phone streams expire unless the app renews their lease", async () => {
  const response = new EventEmitter();
  response.destroyed = false;
  response.destroy = () => {
    response.destroyed = true;
    response.emit("close");
  };
  subscribe("lease-test", response, true);
  renewThreadLease("lease-test", 100);
  await new Promise((resolve) => setTimeout(resolve, 50));
  renewThreadLease("lease-test", 100);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(response.destroyed, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(response.destroyed, true);
});
