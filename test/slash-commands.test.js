import assert from "node:assert/strict";
import test from "node:test";
import {
  completeSlashCommand,
  getSlashCommandCompletions,
  getVisibleSlashCommands
} from "../src/slash-commands.js";

test("slash commands include debug mode", () => {
  assert.ok(getSlashCommandCompletions().includes("/debug"));
  assert.deepEqual(completeSlashCommand("/deb")[0], ["/debug"]);
  assert.deepEqual(getVisibleSlashCommands("/debug").map((command) => command.name), ["/debug"]);
});
