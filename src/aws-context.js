import { execFileSync, execSync } from "node:child_process";

export function getActiveAwsProfile() {
  return process.env.AWS_PROFILE || "default";
}

export function getCommandErrorText(err) {
  return [err?.stdout, err?.stderr, err?.message]
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value))
    .join("\n");
}

export function isExpiredAwsSession(errorText) {
  return /session has expired|reauthenticate|token has expired|sso.*expired/i.test(errorText);
}

export function getAwsConfigValue(key, profile = null) {
  try {
    const args = ["configure", "get", key];
    if (profile) {
      args.push("--profile", profile);
    }
    return execFileSync("aws", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    return "";
  }
}

export function awsLoginCommand() {
  const profile = getActiveAwsProfile();
  const loginProfile = getAwsConfigValue("source_profile", profile) || profile;
  return loginProfile === "default" ? "aws login" : `aws login --profile ${loginProfile}`;
}

export function formatAwsIdentity(identity) {
  if (!identity) return "";

  const account = identity.Account ? `, ${identity.Account}` : "";
  const arn = identity.Arn || "";
  const assumedRoleMatch = arn.match(/:assumed-role\/([^/]+)\/(.+)$/);
  const userMatch = arn.match(/:user\/(.+)$/);

  if (assumedRoleMatch) {
    const [, role, sessionName] = assumedRoleMatch;
    return `${sessionName} (${role}${account})`;
  }
  if (userMatch) {
    return `${userMatch[1]} (IAM${account})`;
  }
  if (arn.endsWith(":root")) {
    return `root (${identity.Account})`;
  }

  return identity.UserId ? `${identity.UserId}${account}` : "";
}

export function isMissingAwsCredentials(errorText) {
  return /unable to locate credentials|could not be found|no credentials|credentials not found/i.test(errorText);
}

export function resolveAwsRegion() {
  return process.env.AWS_REGION ||
    process.env.AWS_DEFAULT_REGION ||
    getAwsConfigValue("region") ||
    "us-east-1";
}

export function loadAwsIdentity() {
  try {
    const identityJson = execSync("aws sts get-caller-identity --output json", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return formatAwsIdentity(JSON.parse(identityJson));
  } catch (err) {
    const errorText = getCommandErrorText(err);
    if (isExpiredAwsSession(errorText)) {
      throw new Error(`AWS Session abgelaufen. Bitte neu anmelden:\n\n  ${awsLoginCommand()}`);
    }
    if (isMissingAwsCredentials(errorText)) {
      throw new Error(`AWS Credentials nicht gefunden. Bitte anmelden oder konfigurieren:\n\n  ${awsLoginCommand()}\n  aws configure`);
    }
    return "";
  }
}

// Der Bedrock-Client nutzt die Default Credential Provider Chain des AWS SDK
// (Umgebungsvariablen, SSO, geteilte Profildateien, Assume-Role). Das SDK
// aktualisiert dabei ablaufende SSO-/Rollen-Sessions selbstständig, statt dass
// der Client statisch extrahierte Schlüssel für die gesamte Laufzeit hält.
export function loadAwsContext() {
  const identityLabel = loadAwsIdentity();
  return {
    region: resolveAwsRegion(),
    identityLabel,
    profile: getActiveAwsProfile()
  };
}

export function listAwsProfiles() {
  try {
    return execSync("aws configure list-profiles", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    })
      .split("\n")
      .map((profile) => profile.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function formatProfileList(profiles) {
  if (!profiles.length) return "Keine AWS-Profile gefunden.";
  const activeProfile = getActiveAwsProfile();
  return profiles
    .map((profile) => profile === activeProfile ? `${profile} (aktiv)` : profile)
    .join(", ");
}

export function printAwsProfiles() {
  console.log(formatProfileList(listAwsProfiles()));
}

export function switchAwsProfile(profile) {
  const profiles = listAwsProfiles();
  if (profiles.length && !profiles.includes(profile)) {
    throw new Error(`AWS Profil nicht gefunden: ${profile}\nVerfuegbar: ${profiles.join(", ")}`);
  }

  if (profile === "default") {
    delete process.env.AWS_PROFILE;
  } else {
    process.env.AWS_PROFILE = profile;
  }

  return loadAwsContext();
}
