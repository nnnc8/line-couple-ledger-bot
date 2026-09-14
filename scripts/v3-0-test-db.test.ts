import assert from "node:assert/strict";
import test from "node:test";
import { createV30TestDatabase, requireLocalTestUrl } from "./v3-0-test-db";

test("PG test guards reject missing, remote and overridden targets before connection", async () => {
  assert.equal(requireLocalTestUrl("postgresql://postgres@127.0.0.1:53660/v3_0_test_fixture").hostname, "127.0.0.1");
  assert.throws(() => requireLocalTestUrl(undefined));
  assert.throws(() => requireLocalTestUrl("postgresql://postgres@localhost/postgres"));
  for (const target of [
    "postgresql://postgres@db.example.com/v3_0_test_fixture",
    "https://localhost/v3_0_test_fixture",
    ...["host=db.example.com", "hostaddr=192.0.2.1", "database=postgres", "dbname=postgres"]
      .map((query) => `postgresql://postgres@localhost/v3_0_test_fixture?${query}`),
  ]) {
    assert.throws(() => requireLocalTestUrl(target));
    await assert.rejects(createV30TestDatabase(target), /loopback/);
  }
});
