import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { requireLocalTestUrl } from "../../../scripts/v3-0-test-db";
import { databasePoolConfig } from "./connection-config";

const url = requireLocalTestUrl(process.env.V3_TEST_DATABASE_URL);
const ca = process.env.V3_TEST_TLS_CA;
if (!ca) throw new Error("V3_TEST_TLS_CA is required; TLS validation cannot silently skip");

async function connect(host: string, trusted: boolean, suffix = "") {
  const target = new URL(url);
  target.hostname = host;
  target.search = suffix;
  const client = new Client(databasePoolConfig(target.href, { NODE_ENV: "production", ...(trusted ? { DATABASE_SSL_CA: ca } : {}) }));
  try {
    await client.connect();
    const result = await client.query("select ssl from pg_stat_ssl where pid = pg_backend_pid()");
    assert.equal(result.rows[0].ssl, true);
  } finally { await client.end(); }
}

test("PG TLS rejects an untrusted server certificate", async () => {
  await assert.rejects(() => connect("localhost", false), /self.signed|certificate/i);
});
test("PG TLS accepts the configured CA and matching hostname, including URL SSL options", async () => {
  await connect("localhost", true);
  await connect("localhost", true, "?sslmode=require&uselibpqcompat=true");
});
test("PG TLS rejects a trusted certificate for the wrong hostname", async () => {
  await assert.rejects(() => connect("127.0.0.1", true), /IP|Hostname|altnames|certificate/i);
});
