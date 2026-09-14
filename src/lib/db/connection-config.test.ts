import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { databasePoolConfig } from "./connection-config";

test("remote TLS remains verified after pg parses require/libpq URL options", () => {
  for (const suffix of ["", "?sslmode=require", "?sslmode=verify-ca&uselibpqcompat=true", "?ssl=true"]) {
    const config = databasePoolConfig(`postgresql://u:p@db.example.com/db${suffix}`, { NODE_ENV: "production", DATABASE_SSL_CA: "test-ca" });
    const client = new Client(config);
    const ssl = client.ssl as unknown as { rejectUnauthorized: boolean; ca: string; checkServerIdentity: unknown };
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca, "test-ca");
    assert.equal(typeof ssl.checkServerIdentity, "function");
  }
});

test("only explicitly local non-production databases may use plaintext", () => {
  assert.equal(databasePoolConfig("postgresql://u:p@127.0.0.1/db", { NODE_ENV: "test" }).ssl, false);
  assert.notEqual(databasePoolConfig("postgresql://u:p@localhost/db", { NODE_ENV: "production" }).ssl, false);
  for (const suffix of ["?sslmode=disable", "?sslmode=no-verify", "?ssl=false", "?host=localhost"]) {
    assert.throws(() => databasePoolConfig(`postgresql://u:p@db.example.com/db${suffix}`));
  }
});
