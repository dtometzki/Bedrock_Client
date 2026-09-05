import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AuthService, IDLE_MS, resolveRoleChain } from "../src/auth.js";
import { CredentialVault } from "../src/credential-vault.js";
import { loadCurrentBedrockBillingCost } from "../src/usage.js";
import { createBedrockClient } from "../src/bedrock.js";
import { parseCliArgs } from "../src/cli-args.js";
import { getAuthDiagnostic } from "../src/auth-diagnostics.js";

const PASSWORD = "test-only-master-passphrase";
const DATA = { accessKeyId: "AKIAEXAMPLEONLY000001", secretAccessKey: "s".repeat(40), profile: "role" };
const PROFILES = {
  role: { role_arn: "arn:aws:iam::123456789012:role/Test", source_profile: "base", region: "eu-central-1", external_id: "test-external", duration_seconds: "1800" },
  other: { role_arn: "arn:aws:iam::123456789012:role/Other", source_profile: "base", region: "us-east-1" },
  base: { aws_access_key_id: "NEVER-USE", aws_secret_access_key: "NEVER-USE" }
};
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-auth-test-"));
  const auth = new AuthService({ vault: new CredentialVault(dir), profiles: async () => PROFILES,
    savedMode: null, persistMode: () => {}, env: {}, ...options });
  t.after(() => { auth.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return auth;
}
async function setup(auth) { await auth.setup(DATA, PASSWORD, PASSWORD); }

test("role chain keeps parameters and replaces only the terminal credential source", () => {
  const profiles = { ...PROFILES, top: { role_arn: "arn:aws:iam::123456789012:role/Top", source_profile: "role", role_session_name: "chat-test" } };
  const roles = resolveRoleChain(profiles, "top");
  assert.deepEqual(roles.map((role) => role.RoleArn), [PROFILES.role.role_arn, profiles.top.role_arn]);
  assert.equal(roles[0].ExternalId, "test-external");
  assert.equal(roles[0].DurationSeconds, 1800);
  assert.equal(roles[1].RoleSessionName, "chat-test");
  for (const profiles of [
    {}, { role: {} }, { role: { ...PROFILES.role, source_profile: "role" } },
    { role: { ...PROFILES.role, mfa_serial: "mfa" } },
    { role: { ...PROFILES.role, duration_seconds: "invalid" } },
    { role: { ...PROFILES.role, role_arn: "invalid" } },
    { role: { ...PROFILES.role, credential_source: "Environment" } }
  ]) assert.throws(() => resolveRoleChain(profiles, "role"));
});

test("idle lock ignores polling, respects activity and does not interrupt active requests", async (t) => {
  let now = 0;
  const auth = fixture(t, { now: () => now });
  await setup(auth);
  now = IDLE_MS - 1;
  assert.equal(auth.status().locked, false);
  auth.touch();
  now += IDLE_MS - 1;
  assert.equal(auth.status().locked, false);
  const operation = auth.begin();
  now += IDLE_MS * 2;
  assert.equal(auth.status().locked, false);
  operation.finish();
  now += IDLE_MS;
  assert.equal(auth.status().locked, true);
  assert.throws(() => auth.begin(), { status: 423 });
  await auth.unlock(PASSWORD);
  assert.equal(auth.status().ready, true);
});

test("lock revokes cached credentials, aborts work and rejects late identity results", async (t) => {
  let finishIdentity;
  let identityStarted;
  const started = new Promise((resolve) => { identityStarted = resolve; });
  let destroyed = 0;
  const auth = fixture(t, { temporary: () => async () => ({ accessKeyId: "temporary", secretAccessKey: "secret", sessionToken: "token", expiration: new Date(Date.now() + 3600000) }),
    identityClient: () => ({ send: async () => { identityStarted(); return new Promise((resolve) => { finishIdentity = resolve; }); }, destroy: () => destroyed++ }) });
  await setup(auth);
  const config = await auth.clientConfig();
  const credentials = await config.credentials();
  const pending = auth.checkConnection();
  await started;
  const operation = auth.begin();
  auth.lock();
  assert.equal(operation.signal.aborted, true);
  assert.equal(credentials.secretAccessKey, "");
  await assert.rejects(config.credentials(), { status: 423 });
  finishIdentity({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test" });
  await assert.rejects(pending, { status: 423 });
  operation.finish();
  assert.equal(auth.status().identityLabel, "");
  assert.equal(auth.status().connectionError, null);
  assert.equal(auth.status().locked, true);
  assert.ok(destroyed > 0);
  await auth.unlock(PASSWORD);
  assert.equal(auth.status().ready, true);
});

test("Bedrock provider, identity and billing share refreshed role credentials and region changes invalidate them", async (t) => {
  let now = Date.now();
  let calls = 0;
  const observed = [];
  const auth = fixture(t, { now: () => now,
    temporary: ({ masterCredentials, params }) => async () => {
      assert.deepEqual(await masterCredentials(), { accessKeyId: DATA.accessKeyId, secretAccessKey: DATA.secretAccessKey });
      calls++;
      return { accessKeyId: `temporary-${calls}`, secretAccessKey: "secret", sessionToken: params.RoleArn, expiration: new Date(now + 120000) };
    }, identityClient: (config) => ({
      send: async () => { observed.push(await config.credentials()); return { Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test" }; }, destroy() {}
    }) });
  await setup(auth);
  const config = await auth.clientConfig();
  assert.equal(config.region, "eu-central-1");
  const bedrock = auth.track(createBedrockClient(config));
  observed.push(await bedrock.config.credentials());
  assert.equal(await bedrock.config.region(), "eu-central-1");
  await auth.checkConnection();
  const billing = await loadCurrentBedrockBillingCost({ auth, createClient: (config) => ({
    send: async (command) => {
      observed.push(await config.credentials());
      assert.equal(config.region, "us-east-1");
      return command.constructor.name === "GetDimensionValuesCommand" ? { DimensionValues: [{ Value: "Amazon Bedrock" }] } : { ResultsByTime: [{ Total: { UnblendedCost: { Amount: "1.25", Unit: "USD" } } }] };
    }, destroy() {}
  }) });
  assert.equal(billing.amount, 1.25);
  assert.equal(calls, 1);
  assert.ok(observed.every((credentials) => credentials.accessKeyId === "temporary-1"));
  now += 70000;
  assert.equal((await config.credentials()).accessKeyId, "temporary-2");
  await auth.changeProfile("other");
  await assert.rejects(config.credentials(), { status: 423 });
  const other = await auth.clientConfig();
  assert.equal(other.region, "us-east-1");
  assert.equal((await other.credentials()).sessionToken, PROFILES.other.role_arn);
});

test("failed AWS login retains vault; locked billing makes no AWS call", async (t) => {
  const auth = fixture(t, { identityClient: () => ({ send: async () => { throw new Error(DATA.secretAccessKey); }, destroy() {} }) });
  await setup(auth);
  await assert.rejects(auth.checkConnection(), (err) => !err.message.includes(DATA.secretAccessKey));
  assert.equal(auth.status().locked, false);
  auth.lock();
  const billing = await loadCurrentBedrockBillingCost({ auth, createClient: () => { assert.fail("must not create AWS client while locked"); } });
  assert.match(billing.error, /gesperrt/);
  await auth.unlock(PASSWORD);
  assert.equal(auth.status().ready, true);
});

test("concurrent mutations are rejected, lock during KDF cannot unlock later, and retries are delayed", async (t) => {
  let now = 0;
  const auth = fixture(t, { now: () => now });
  await setup(auth);
  auth.lock();
  const pending = auth.unlock(PASSWORD);
  await assert.rejects(auth.unlock(PASSWORD), { status: 409 });
  auth.lock();
  await assert.rejects(pending, { status: 423 });
  assert.equal(auth.status().locked, true);
  await assert.rejects(auth.unlock("wrong-master-passphrase"), { status: 401 });
  await assert.rejects(auth.unlock(PASSWORD), { status: 429 });
  now = 1000;
  await auth.unlock(PASSWORD);
  const operation = auth.begin();
  await assert.rejects(auth.changeProfile("other"), { status: 409 });
  await assert.rejects(auth.remove("TRESOR LOESCHEN"), { status: 409 });
  operation.finish();
  await auth.changeProfile("other");
  assert.equal(auth.status().profile, "other");
});

test("password change, restart, deletion failures and confirmed reset", async (t) => {
  const auth = fixture(t);
  await setup(auth);
  const before = auth.vault.read();
  await assert.rejects(auth.changePassword(PASSWORD, "another-master-passphrase", "different"));
  assert.equal(auth.vault.read(), before);
  await auth.changePassword(PASSWORD, "another-master-passphrase", "another-master-passphrase");
  auth.lock();
  await assert.rejects(auth.vault.unlock(PASSWORD), { status: 401 });
  await auth.unlock("another-master-passphrase");
  const second = new AuthService({ vault: auth.vault, profiles: async () => PROFILES, savedMode: null, persistMode: () => {} });
  t.after(() => second.close());
  assert.equal(second.status().mode, "vault");
  assert.equal(second.status().locked, true);
  assert.equal(second.status().roleName, "");
  await assert.rejects(second.remove("yes"));
  fs.mkdirSync(`${auth.vault.file}.lock`);
  await assert.rejects(auth.remove("TRESOR LOESCHEN"), { status: 409 });
  assert.equal(auth.status().locked, false);
  fs.rmdirSync(`${auth.vault.file}.lock`);
  await second.remove("TRESOR LOESCHEN");
  assert.equal(second.status().exists, false);
});

test("role chain failures identify the failed source role and recovery clears diagnostics", async (t) => {
  let fail = true;
  const auth = fixture(t, {
    profiles: async () => ({ ...PROFILES, top: { role_arn: "arn:aws:iam::123456789012:role/Top", source_profile: "role" } }),
    temporary: ({ params, masterCredentials }) => async () => {
      await masterCredentials();
      if (fail && params.RoleArn === PROFILES.role.role_arn) throw Object.assign(new Error(DATA.secretAccessKey), { name: "AccessDenied" });
      return { accessKeyId: "temporary", secretAccessKey: "temporary-secret", expiration: new Date(Date.now() + 3600000) };
    },
    identityClient: (config) => ({ send: async () => { await config.credentials(); return { Arn: "arn:aws:sts::123456789012:assumed-role/Top/test" }; }, destroy() {} })
  });
  await auth.setup({ ...DATA, profile: "top" }, PASSWORD, PASSWORD);
  const original = auth.vault.read();
  await assert.rejects(auth.checkConnection(), (error) => {
    assert.equal(getAuthDiagnostic(error).roleArn, PROFILES.role.role_arn);
    assert.match(error.message, /AssumeRole/);
    assert.ok(!error.message.includes(DATA.secretAccessKey));
    return true;
  });
  assert.equal(auth.status().connectionError.profile, "top");
  assert.equal(auth.status().roleName, "Top");
  assert.equal(auth.vault.read(), original);
  fail = false;
  await auth.checkConnection();
  assert.equal(auth.status().connectionError, null);
  assert.equal(auth.status().connection, "connected");
  await auth.changeProfile("other");
  assert.equal(auth.status().roleName, "Other");
  assert.equal(auth.status().connection, "unchecked");
  auth.lock();
  assert.equal(auth.status().roleName, "Other", "public role metadata remains visible during a process lifetime");
  assert.equal(auth.status().profile, "", "vault profile stays encrypted at rest");
});

test("late failed identity checks cannot restore details after locking", async (t) => {
  let rejectIdentity;
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  const auth = fixture(t, { identityClient: () => ({ send: () => { announce(); return new Promise((_, reject) => { rejectIdentity = reject; }); }, destroy() {} }) });
  await setup(auth);
  const pending = auth.checkConnection();
  await started;
  auth.lock();
  rejectIdentity(Object.assign(new Error("private SDK message"), { name: "AccessDenied" }));
  await assert.rejects(pending, { status: 423 });
  assert.equal(auth.status().connectionError, null);
  assert.equal(auth.status().connection, "unchecked");
  await auth.unlock(PASSWORD);
  assert.equal(auth.status().ready, true);
});

test("invalid role configuration has actionable diagnostics and leaves setup retryable", async (t) => {
  let profiles = { role: { ...PROFILES.role, source_profile: "role" } };
  const auth = fixture(t, { profiles: async () => profiles });
  await assert.rejects(auth.setup(DATA, PASSWORD, PASSWORD), (error) => {
    assert.match(getAuthDiagnostic(error).reason, /Kreis in source_profile.*role/);
    assert.equal(getAuthDiagnostic(error).code, "ConfigurationError");
    return true;
  });
  assert.equal(auth.vault.exists(), false);
  profiles = PROFILES;
  await setup(auth);
  assert.equal(auth.status().ready, true);
});

test("existing AWS profile metadata is available without making an AWS request", async (t) => {
  const auth = fixture(t, { mode: "aws", profile: "other", identityClient: () => assert.fail("must not call STS") });
  await auth.refreshProfileMetadata();
  assert.equal(auth.status().roleName, "Other");
  assert.equal(auth.status().region, "us-east-1");
  assert.equal(auth.status().connection, "unchecked");
  assert.equal(auth.status().ready, true);
});

test("CLI auth options retain explicit profile precedence", (t) => {
  assert.equal(parseCliArgs(["--auth", "vault"]).auth, "vault");
  assert.equal(parseCliArgs(["--auth-setup"]).authSetup, true);
  assert.throws(() => parseCliArgs(["--auth", "bad"]), /aws oder vault/);
  assert.throws(() => parseCliArgs(["--password", PASSWORD]));
  assert.equal(fixture(t, { savedMode: "vault", profile: "role" }).mode, "aws");
  assert.equal(fixture(t, { savedMode: "aws", mode: "vault", profile: "role" }).mode, "vault");
});

test("invalid profile switches preserve unlocked data and the next valid switch works", async (t) => {
  const auth = fixture(t);
  await setup(auth);
  const original = auth.vault.read();
  await assert.rejects(auth.changeProfile("missing"));
  assert.equal(auth.vault.read(), original);
  assert.equal(auth.status().locked, false);
  assert.equal(auth.status().profile, "role");
  await auth.changeProfile("other");
  assert.equal(auth.status().profile, "other");
});

test("cancelling the last active request also aborts the internal STS transport", async (t) => {
  const { NodeHttpHandler } = await import("@smithy/node-http-handler");
  let announce;
  const started = new Promise((resolve) => { announce = resolve; });
  let transportSignal;
  t.mock.method(NodeHttpHandler.prototype, "handle", async (_request, { abortSignal }) => {
    transportSignal = abortSignal;
    announce();
    await new Promise((resolve) => abortSignal.addEventListener("abort", resolve, { once: true }));
    throw Object.assign(new Error("cancelled"), { name: "AbortError" });
  });
  const auth = fixture(t, { temporary: ({ clientConfig }) => () => clientConfig.requestHandler.handle({}, {}) });
  await setup(auth);
  const operation = auth.begin();
  const secondOperation = auth.begin();
  const config = await auth.clientConfig();
  const pending = config.credentials();
  await started;
  operation.cancel();
  assert.equal(transportSignal.aborted, false, "another request still needs the shared role login");
  secondOperation.cancel();
  secondOperation.finish();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(transportSignal.aborted, true);
  operation.finish();
  assert.equal(auth.status().locked, false);
  await auth.changeProfile("other");
});
