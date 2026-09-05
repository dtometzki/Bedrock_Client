export function authModeExplanation(mode) {
  return mode === "aws"
    ? "Hier wird kein Masterpasswort benötigt – auch nach Stop und Neustart nicht. Der Client verwendet die außerhalb des Clients eingerichtete AWS-Anmeldung. Deine Tresorschlüssel werden dabei nicht verwendet."
    : "Deine Schlüssel werden im Tresor verschlüsselt gespeichert und mit dem Masterpasswort entsperrt. Damit nimmt der Client die gewählte AWS-Rolle an. Nach Neustart oder 15 Minuten Inaktivität erneut entsperren.";
}

export function formatAuthSummary(state) {
  if (!state) return "AWS-Anmeldung wird geladen …";
  const source = state.mode === "vault" ? "Tresor" : "Bestehende AWS-Anmeldung";
  const role = state.roleName ? `Rolle ${state.roleName}` : state.profile ? `Profil ${state.profile}` : state.mode === "vault" && state.exists ? "Rolle nach Entsperren sichtbar" : "keine Rolle ausgewählt";
  const lock = state.mode === "aws" ? "ohne Masterpasswort" : !state.exists ? "nicht eingerichtet" : state.locked ? "gesperrt" : "entsperrt";
  const connection = { connected: "AWS geprüft", failed: "AWS-Prüfung fehlgeschlagen", unchecked: "AWS noch nicht geprüft" }[state.connection] || "AWS noch nicht geprüft";
  return [source, role, lock, connection].join(" · ");
}

export function formatAuthDiagnostic(details) {
  if (!details) return "";
  return [
    `Schritt: ${details.step}`,
    details.profile && `Profil: ${details.profile}`,
    details.roleArn && `Angeforderte Rolle: ${details.roleArn}`,
    details.region && `Region: ${details.region}`,
    `Fehlercode: ${details.code}${details.httpStatus ? ` (HTTP ${details.httpStatus})` : ""}`,
    details.requestId && `AWS-Request-ID: ${details.requestId}`,
    details.reason,
    `Nächster Schritt: ${details.nextStep}`
  ].filter(Boolean).join("\n");
}
