import assert from "node:assert/strict";
import { test } from "node:test";
import { installCommandProcessFake } from "../support/infrastructure/command-process-fake.js";

test("command process fixtures select the newest dependency and restore the prior scope", async () => {
  class Command {
    constructor() { this.runCommand = () => "original"; }
    async execute(input) { return `${input}:${await this.runCommand()}`; }
  }
  const command = new Command();
  const first = installCommandProcessFake(Command, async () => "first");
  try {
    assert.equal(await command.execute("input"), "input:first");
    const second = installCommandProcessFake(Command, async () => "second");
    try {
      assert.equal(await command.execute("input"), "input:second");
      assert.equal(command.runCommand(), "original");
    } finally { second.mock.restore(); }
    assert.equal(await command.execute("input"), "input:first");
  } finally { first.mock.restore(); }
  assert.equal(await command.execute("input"), "input:original");
});
