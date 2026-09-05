import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatAwsIdentity, formatProfileList, readAwsProfiles } from "../src/aws-context.js";

test("profile parser reads role metadata without invoking the AWS CLI", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-profile-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFilepath = path.join(dir, "config");
  const filepath = path.join(dir, "credentials");
  fs.writeFileSync(configFilepath, "[profile role]\nrole_arn = arn:aws:iam::123456789012:role/Test\nsource_profile = base\nregion = eu-central-1\n");
  fs.writeFileSync(filepath, "[base]\naws_access_key_id = FAKE-TEST-KEY\n");
  const profiles = await readAwsProfiles({ configFilepath, filepath });
  assert.equal(profiles.role.source_profile, "base");
  assert.equal(profiles.role.region, "eu-central-1");
  assert.equal(profiles.base.aws_access_key_id, "FAKE-TEST-KEY");
  fs.appendFileSync(configFilepath, "[profile next]\nregion = us-east-1\n");
  assert.equal((await readAwsProfiles({ configFilepath, filepath })).next.region, "us-east-1");
});

test("profile and identity display remove terminal control sequences", () => {
  assert.equal(formatAwsIdentity(null), "");
  assert.equal(formatAwsIdentity({ Arn: "arn:aws:sts::123456789012:assumed-role/Test/session", Account: "123456789012" }), "session (Test, 123456789012)");
  assert.equal(formatProfileList(["role", "other"], "role"), "role (aktiv), other");
  assert.ok(!formatProfileList(["bad\x1b[31m"], "role").includes("\x1b"));
  assert.ok(!formatAwsIdentity({ UserId: "bad\x1b[31m" }).includes("\x1b"));
});
