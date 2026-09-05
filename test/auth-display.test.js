import assert from "node:assert/strict";
import { test } from "node:test";
import { authModeExplanation, formatAuthSummary } from "../src/auth-display.js";
import { annotateAuthFailure, authFailureResponse, getAuthDiagnostic, safeAwsError } from "../src/auth-diagnostics.js";

test("auth summaries distinguish a locked vault from an existing login without a password", () => {
  assert.match(formatAuthSummary({ mode: "vault", exists: true, locked: true, roleName: "Admins" }), /Tresor · Rolle Admins · gesperrt/);
  assert.match(formatAuthSummary({ mode: "vault", exists: true, locked: true }), /Rolle nach Entsperren sichtbar/);
  assert.match(formatAuthSummary({ mode: "vault", exists: false }), /nicht eingerichtet/);
  const aws = formatAuthSummary({ mode: "aws", locked: true, profile: "Admins" });
  assert.match(aws, /Bestehende AWS-Anmeldung · Profil Admins · ohne Masterpasswort/);
  assert.doesNotMatch(aws, /gesperrt|entsperrt/);
  assert.match(authModeExplanation("aws"), /kein Masterpasswort.*auch nach Stop und Neustart/);
  assert.match(authModeExplanation("vault"), /15 Minuten/);
});

test("AWS diagnostics preserve error identity and only expose allowlisted metadata", () => {
  const secret = "NEVER-EXPOSE-THIS-SECRET";
  const error = Object.assign(new Error(secret), { name: "AccessDenied", details: { secret },
    $metadata: { httpStatusCode: 403, requestId: "12345678-1234-1234-1234-123456789abc", headers: { authorization: secret } } });
  const annotated = annotateAuthFailure(error, { stage: "assumeRole", profile: "Admins", roleArn: "arn:aws:iam::123456789012:role/Admins", region: "eu-central-1" });
  assert.equal(annotated, error, "SDK retry logic must retain the original error");
  const details = getAuthDiagnostic(error);
  assert.equal(details.code, "AccessDenied");
  assert.equal(details.httpStatus, 403);
  assert.equal(details.requestId, error.$metadata.requestId);
  assert.equal(details.roleArn, "arn:aws:iam::123456789012:role/Admins");
  assert.equal(getAuthDiagnostic(authFailureResponse(error)), details);
  assert.doesNotMatch(JSON.stringify(details) + safeAwsError(error), new RegExp(secret));
  assert.equal(annotateAuthFailure(error, { stage: "identity" }), error);
  assert.match(getAuthDiagnostic(error).step, /AssumeRole/);
  const unknown = annotateAuthFailure(Object.assign(new Error(secret), { name: secret, code: secret, $metadata: { httpStatusCode: secret, requestId: secret } }),
    { stage: "identity", profile: "<script>", roleArn: secret, region: secret });
  assert.deepEqual(Object.keys(getAuthDiagnostic(unknown)).sort(), ["code", "nextStep", "step"]);
  assert.equal(getAuthDiagnostic(unknown).code, "UnknownError");
  assert.doesNotMatch(safeAwsError(unknown), new RegExp(secret));
});
