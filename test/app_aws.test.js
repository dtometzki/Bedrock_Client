import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");
const appPath = path.join(repoRoot, "app_aws.js");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function createFakeAwsBin() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-client-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  const awsPath = path.join(binDir, "aws");
  fs.writeFileSync(
    awsPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const profile = process.env.AWS_PROFILE || "default";

if (args.join(" ") === "configure list-profiles") {
  console.log("default\\nbedrok\\nAdmins\\ns3");
  process.exit(0);
}

if (args[0] === "configure" && args[1] === "get") {
  if (args[2] === "region") console.log("eu-central-1");
  process.exit(0);
}

if (args.join(" ") === "configure export-credentials") {
  console.log(JSON.stringify({
    Version: 1,
    AccessKeyId: "ASIATEST",
    SecretAccessKey: "secret",
    SessionToken: "token"
  }));
  process.exit(0);
}

if (args[0] === "sts" && args[1] === "get-caller-identity") {
  const isAdmin = profile === "Admins";
  console.log(JSON.stringify({
    UserId: isAdmin ? "AROADMIN:Damian" : "AROBEDROK:Bedrok-Role",
    Account: "123456789012",
    Arn: isAdmin
      ? "arn:aws:sts::123456789012:assumed-role/Admins/Damian"
      : "arn:aws:sts::123456789012:assumed-role/bedrok/Bedrok-Role"
  }));
  process.exit(0);
}

console.error("unexpected aws command:", args.join(" "));
process.exit(1);
`,
    { mode: 0o755 }
  );
  return { tmpDir, binDir };
}

function runApp(args, { input = "", env = {} } = {}) {
  const { binDir } = createFakeAwsBin();
  return spawnSync(process.execPath, [appPath, ...args], {
    cwd: repoRoot,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      AWS_REGION: "",
      AWS_PROFILE: env.AWS_PROFILE || ""
    }
  });
}

test("prints the package version", () => {
  const result = runApp(["--version"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), `bedrock-chat ${packageJson.version}`);
});

test("lists configured AWS profiles without starting chat", () => {
  const result = runApp(["-p", "-list"]);
  assert.equal(result.status, 0);
  assert.equal(stripAnsi(result.stdout).trim(), "default (aktiv), bedrok, Admins, s3");
});

test("starts with the requested Admins profile", () => {
  const result = runApp(["-p", "Admins"], { input: "/exit\n" });
  const output = stripAnsi(result.stdout);
  assert.equal(result.status, 0);
  assert.match(output, /Damian \(Admins, 123456789012\)/);
  assert.match(output, /Admins \(eu-central-1\)/);
  assert.match(output, /Chat beendet\./);
});

test("starts with the requested bedrok profile", () => {
  const result = runApp(["-p", "bedrok"], { input: "/exit\n" });
  const output = stripAnsi(result.stdout);
  assert.equal(result.status, 0);
  assert.match(output, /Bedrok-Role \(bedrok, 123456789012\)/);
  assert.match(output, /bedrok \(eu-central-1\)/);
  assert.match(output, /Chat beendet\./);
});
