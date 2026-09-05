import { parseKnownFiles } from "@smithy/shared-ini-file-loader";
import { sanitizeTerminalText } from "./response-format.js";

export async function readAwsProfiles(options = {}) {
  return parseKnownFiles({ ...options, ignoreCache: true });
}

export function getActiveAwsProfile() {
  return process.env.AWS_PROFILE || "default";
}

export function formatAwsIdentity(identity) {
  if (!identity) return "";

  const account = identity.Account ? `, ${identity.Account}` : "";
  const arn = typeof identity.Arn === "string" ? identity.Arn : "";
  const assumedRoleMatch = arn.match(/:assumed-role\/([^/]+)\/(.+)$/);
  const userMatch = arn.match(/:user\/(.+)$/);

  if (assumedRoleMatch) {
    const [, role, sessionName] = assumedRoleMatch;
    return sanitizeTerminalText(`${sessionName} (${role}${account})`);
  }
  if (userMatch) {
    return sanitizeTerminalText(`${userMatch[1]} (IAM${account})`);
  }
  if (arn.endsWith(":root")) {
    return sanitizeTerminalText(`root (${identity.Account})`);
  }

  return identity.UserId ? sanitizeTerminalText(`${identity.UserId}${account}`) : "";
}


export function formatProfileList(profiles, activeProfile = getActiveAwsProfile()) {
  if (!profiles.length) return "Keine AWS-Profile gefunden.";
  return profiles.map((profile) => sanitizeTerminalText(profile === activeProfile ? `${profile} (aktiv)` : profile)).join(", ");
}

export async function printAwsProfiles() {
  console.log(formatProfileList(Object.keys(await readAwsProfiles()).sort()));
}
