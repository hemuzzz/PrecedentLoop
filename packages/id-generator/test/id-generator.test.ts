import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { ID_PREFIXES, SnowflakeIdGenerator } from "../src/index.js";

test("generates and validates the three prefixed decimal ID formats", () => {
  const generator = new SnowflakeIdGenerator();

  for (const prefix of ID_PREFIXES) {
    const id = generator.next(prefix);

    assert.match(id, new RegExp(`^${prefix}[0-9]+$`));
    assert.equal(id.includes("_"), false);
    assert.equal(generator.validate(id), true);
    assert.equal(generator.validate(id, prefix), true);
  }

  assert.equal(generator.validate("ast_123"), false);
  assert.equal(generator.validate("other123"), false);
  assert.equal(generator.validate(generator.next("ast"), "tsk"), false);
});

test("keeps the underlying Snowflake values unique across concurrent calls", async () => {
  const generator = new SnowflakeIdGenerator();
  const count = 20_000;
  const ids = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      Promise.resolve().then(() => generator.next(ID_PREFIXES[index % ID_PREFIXES.length]!)),
    ),
  );
  const snowflakeValues = ids.map((id) => id.slice(3));

  assert.equal(new Set(snowflakeValues).size, count);
});

test("returns JSON-safe strings instead of exposing bigint values", () => {
  const generator = new SnowflakeIdGenerator();
  const id = generator.next("usg");

  assert.equal(typeof id, "string");
  assert.equal(JSON.stringify({ id }), `{"id":"${id}"}`);
});

test("refuses generation when the system clock moves backwards", () => {
  const generator = new SnowflakeIdGenerator();
  const firstId = generator.next("tsk");
  const rollbackTimestamp = Date.now() - 10_000;
  const dateNow = mock.method(Date, "now", () => rollbackTimestamp);

  try {
    assert.throws(
      () => generator.next("tsk"),
      /Clock moved backwards by [0-9]+ms\. Refusing to generate ID\./,
    );
  } finally {
    dateNow.mock.restore();
  }

  assert.equal(generator.validate(firstId, "tsk"), true);
});
