import { AuthError } from "./credential-vault.js";
import { formatAuthDiagnostic } from "./auth-display.js";

const diagnostics = new WeakMap();
const STEPS = { profile: "Rollenkonfiguration prüfen", credentials: "AWS-Anmeldung laden", assumeRole: "Rolle übernehmen (STS AssumeRole)", identity: "Identität prüfen (STS GetCallerIdentity)" };
const MESSAGES = {
  AccessDeniedException: "AWS hat den Zugriff verweigert.", AccessDenied: "AWS hat den Zugriff verweigert.",
  InvalidClientTokenId: "AWS-Zugangsdaten sind ungültig.", SignatureDoesNotMatch: "AWS-Zugangsdaten sind ungültig.",
  ExpiredToken: "AWS-Sitzung ist abgelaufen.", CredentialsProviderError: "AWS-Anmeldung fehlt oder muss erneuert werden.",
  AbortError: "AWS-Anfrage abgebrochen.", ValidationException: "AWS hat die Anfrage abgelehnt.",
  ThrottlingException: "AWS-Anfragelimit erreicht.", ServiceUnavailableException: "AWS-Dienst momentan nicht erreichbar.",
  ENOTFOUND: "AWS-Endpunkt konnte nicht gefunden werden.", ETIMEDOUT: "AWS-Verbindung hat zu lange gedauert.", ECONNRESET: "AWS-Verbindung wurde unterbrochen."
};

export function roleNameFromArn(arn) {
  return typeof arn === "string" && /^arn:aws(?:-[a-z-]+)?:iam::\d{12}:role\/[\w+=,.@/\-]{1,512}$/.test(arn) ? arn.split(":role/")[1] : "";
}

export function getAuthDiagnostic(error) { return diagnostics.get(error) || null; }

export function authFailureResponse(error, status = 502) {
  const response = new AuthError(safeAwsError(error), status);
  const details = getAuthDiagnostic(error);
  if (details) diagnostics.set(response, details);
  return response;
}

// Only known codes, validated configuration metadata and UUID request IDs cross the boundary.
// Never copy SDK messages, stacks, request headers, response bodies or credential objects.
export function annotateAuthFailure(error, { stage, profile, roleArn, region } = {}) {
  const err = error instanceof Error ? error : new Error("AWS-Anmeldung fehlgeschlagen.");
  if (diagnostics.has(err) || (err instanceof AuthError && [409, 423, 429].includes(err.status))) return err;
  const code = Object.hasOwn(MESSAGES, err.name) ? err.name : Object.hasOwn(MESSAGES, err.code) ? err.code : stage === "profile" && err instanceof AuthError ? "ConfigurationError" : "UnknownError";
  let nextStep = "Profil und Netzwerk prüfen und die AWS-Verbindung erneut testen.";
  if (stage === "profile") nextStep = "Die lokale AWS-Konfiguration korrigieren. Rollenprofil, role_arn und source_profile prüfen; die Quelle darf keinen Kreis bilden.";
  else if (["AccessDenied", "AccessDeniedException"].includes(code) && stage === "assumeRole") nextStep = "Für die aufrufende Identität sts:AssumeRole und die Vertrauensrichtlinie der angegebenen Rolle prüfen. Bedingungen können ebenfalls sperren (z. B. MFA; im Tresor nicht unterstützt). Das fehlgeschlagene Ereignis in AWS CloudTrail und die geltenden Richtlinien prüfen; diese Anzeige allein bestimmt nicht die ablehnende Richtlinie.";
  else if (["InvalidClientTokenId", "SignatureDoesNotMatch"].includes(code)) nextStep = "Verwendete Zugangsdaten prüfen; gespeicherte Schlüssel bei Bedarf ersetzen.";
  else if (code === "ExpiredToken" || code === "CredentialsProviderError") nextStep = "Die bestehende AWS-Anmeldung außerhalb des Clients erneuern; im Tresormodus die gespeicherten Basisschlüssel prüfen.";
  else if (code === "ThrottlingException") nextStep = "Kurz warten und die Verbindungsprüfung wiederholen.";
  else if (stage === "identity" && ["AccessDenied", "AccessDeniedException"].includes(code)) nextStep = "Die STS-Anfrage und gegebenenfalls Netzwerk-/Endpoint-Richtlinien in AWS prüfen. Dies ist keine bestätigte Ablehnung einer Rollenübernahme.";
  const details = {
    step: STEPS[stage] || STEPS.credentials, code, nextStep,
    ...(typeof profile === "string" && /^[\w.@+=,-]{1,128}$/.test(profile) && { profile }),
    ...(roleNameFromArn(roleArn) && { roleArn }),
    ...(typeof region === "string" && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) && { region }),
    ...(stage === "profile" && err instanceof AuthError && { reason: err.message })
  };
  const metadata = err.$metadata;
  if (Number.isInteger(metadata?.httpStatusCode) && metadata.httpStatusCode >= 100 && metadata.httpStatusCode <= 599) details.httpStatus = metadata.httpStatusCode;
  if (typeof metadata?.requestId === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(metadata.requestId)) details.requestId = metadata.requestId;
  diagnostics.set(err, Object.freeze(details));
  return err;
}

export function safeAwsError(err) {
  const details = getAuthDiagnostic(err);
  if (details) return `${MESSAGES[details.code] || "AWS-Anmeldung fehlgeschlagen."}\n${formatAuthDiagnostic(details)}`;
  if (err instanceof AuthError) return err.message;
  return Object.hasOwn(MESSAGES, err?.name) ? MESSAGES[err.name] : "AWS-Anmeldung oder Verbindung fehlgeschlagen. Profil, Berechtigungen und Netzwerk prüfen.";
}
