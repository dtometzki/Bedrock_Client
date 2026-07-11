import assert from "node:assert/strict";
import test from "node:test";
import { switchAwsProfile } from "../src/aws-context.js";

test("switchAwsProfile stellt AWS_PROFILE nach fehlgeschlagenem Wechsel wieder her", () => {
  const previousProfile = process.env.AWS_PROFILE;
  process.env.AWS_PROFILE = "stable";

  try {
    assert.throws(() => switchAwsProfile("broken", {
      listProfiles: () => ["stable", "broken"],
      loadContext: () => {
        assert.equal(process.env.AWS_PROFILE, "broken");
        throw new Error("Session abgelaufen");
      }
    }), /Session abgelaufen/);
    assert.equal(process.env.AWS_PROFILE, "stable");
  } finally {
    if (previousProfile == null) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = previousProfile;
  }
});

test("switchAwsProfile behaelt das neue Profil nach erfolgreichem Wechsel", () => {
  const previousProfile = process.env.AWS_PROFILE;

  try {
    const context = switchAwsProfile("working", {
      listProfiles: () => ["working"],
      loadContext: () => ({ profile: process.env.AWS_PROFILE })
    });
    assert.equal(context.profile, "working");
    assert.equal(process.env.AWS_PROFILE, "working");
  } finally {
    if (previousProfile == null) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = previousProfile;
  }
});
