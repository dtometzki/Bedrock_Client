import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CredentialVault, disposeSecrets } from "../src/credential-vault.js";

const DATA = { accessKeyId: "AKIAEXAMPLEONLY000001", secretAccessKey: "s".repeat(40), profile: "example-role" };
const PASSWORD = "test-only-master-passphrase";
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-vault-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new CredentialVault(path.join(directory, "config"));
}

test("vault encrypts all credential fields, uses private permissions and unlocks after restart", async (t) => {
  const vault = fixture(t);
  const session = await vault.prepare(DATA, PASSWORD);
  t.after(() => disposeSecrets(session));
  vault.save(session, null);
  const raw = fs.readFileSync(vault.file, "utf8");
  for (const secret of [...Object.values(DATA), PASSWORD]) assert.ok(!raw.includes(secret));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(vault.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(vault.directory).mode & 0o777, 0o700);
  }
  const restored = await new CredentialVault(vault.directory).unlock(PASSWORD);
  assert.deepEqual(restored.data, DATA);
  disposeSecrets(restored);
  assert.ok(restored.key.every((byte) => byte === 0));
  const before = session.revision;
  vault.save(session, before);
  assert.notEqual(session.revision, before, "every save uses a fresh IV");
});

test("wrong passwords and tampering leave the file untouched and allow the next valid unlock", async (t) => {
  const vault = fixture(t);
  const session = await vault.prepare(DATA, PASSWORD);
  t.after(() => disposeSecrets(session));
  vault.save(session, null);
  const original = vault.read();
  await assert.rejects(vault.unlock("wrong-password-123"), /Masterpasswort falsch/);
  assert.equal(vault.read(), original);
  const decoded = JSON.parse(original);
  decoded.tag = Buffer.alloc(16, 0).toString("base64");
  fs.writeFileSync(vault.file, JSON.stringify(decoded));
  await assert.rejects(vault.unlock(PASSWORD), /Masterpasswort falsch/);
  fs.writeFileSync(vault.file, original);
  const valid = await vault.unlock(PASSWORD);
  assert.deepEqual(valid.data, DATA);
  disposeSecrets(valid);
});

test("vault rejects hostile envelope parameters before expensive KDF and supports explicit reset", async (t) => {
  const vault = fixture(t);
  fs.mkdirSync(vault.directory);
  for (const envelope of [{ version: 90 }, { version: 1, cipher: "aes-256-gcm", kdf: { name: "scrypt", N: 2 ** 30, r: 8, p: 1 } }]) {
    fs.writeFileSync(vault.file, JSON.stringify(envelope));
    await assert.rejects(vault.unlock(PASSWORD), /Format nicht unterstuetzt/);
  }
  fs.writeFileSync(vault.file, "x".repeat(20000));
  await assert.rejects(vault.unlock(PASSWORD), /zu gross/);
  vault.delete(vault.currentRevision());
  assert.equal(vault.exists(), false);
});

test("stale writers, password changes and stale deletes cannot overwrite another client", async (t) => {
  const vault = fixture(t);
  const one = await vault.prepare(DATA, PASSWORD);
  vault.save(one, null);
  const secondVault = new CredentialVault(vault.directory);
  const two = await secondVault.unlock(PASSWORD);
  const changed = await vault.prepare({ ...DATA, profile: "new-role" }, "changed-master-passphrase");
  vault.save(changed, one.revision);
  t.after(() => [one, two, changed].forEach(disposeSecrets));
  assert.throws(() => secondVault.save(two, two.revision), { status: 409 });
  assert.throws(() => secondVault.delete(two.revision), { status: 409 });
  await assert.rejects(vault.unlock(PASSWORD), { status: 401 });
  const restored = await vault.unlock("changed-master-passphrase");
  assert.equal(restored.data.profile, "new-role");
  disposeSecrets(restored);
});

test("write locks and filesystem errors preserve existing data and permit a later valid save", async (t) => {
  const vault = fixture(t);
  const session = await vault.prepare(DATA, PASSWORD);
  t.after(() => disposeSecrets(session));
  vault.save(session, null);
  const before = vault.read();
  fs.mkdirSync(`${vault.file}.lock`);
  assert.throws(() => vault.save(session, session.revision), { status: 409 });
  assert.throws(() => vault.delete(session.revision), { status: 409 });
  assert.equal(vault.read(), before);
  fs.rmdirSync(`${vault.file}.lock`);
  const rename = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("private details"), { code: "ENOSPC" }); });
  assert.throws(() => vault.save(session, session.revision), /konnte nicht gespeichert/);
  assert.equal(vault.read(), before);
  rename.mock.restore();
  vault.save(session, session.revision);
  const unlink = t.mock.method(fs, "unlinkSync", () => { throw new Error("private details"); });
  assert.throws(() => vault.delete(session.revision), /konnte nicht geloescht/);
  assert.equal(vault.exists(), true);
  unlink.mock.restore();
  vault.delete(session.revision);
  assert.equal(vault.exists(), false);
});

test("invalid credentials and passwords are rejected without creating a vault", async (t) => {
  const vault = fixture(t);
  for (const data of [null, [], { ...DATA, accessKeyId: {} }, { ...DATA, secretAccessKey: "short" }, { ...DATA, profile: "../bad" }, { ...DATA, sessionToken: "unsupported" }, { ...DATA, accessKeyId: "ASIAEXAMPLEONLY000001" }]) {
    await assert.rejects(vault.prepare(data, PASSWORD));
  }
  for (const password of [null, {}, "short", "x".repeat(1025), "long-password\nwith-control"]) await assert.rejects(vault.prepare(DATA, password));
  assert.equal(vault.exists(), false);
});
