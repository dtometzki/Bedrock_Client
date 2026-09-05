import { combineAbortSignals } from "./abort-signals.js";
import { EventEmitter } from "node:events";
import { fromIni, fromNodeProviderChain, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { CredentialVault, AuthError, disposeSecrets, validateCredentials, validateProfile } from "./credential-vault.js";
import { readSavedAuthMode, writeSavedAuthMode } from "./config.js";
import { formatAwsIdentity, readAwsProfiles } from "./aws-context.js";

export const IDLE_MS = 15 * 60 * 1000;

export function resolveRoleChain(profiles, name) {
  validateProfile(name);
  const visited = new Set();
  const roles = [];
  let current = name;
  while (current) {
    if (visited.has(current) || visited.size >= 20) throw new AuthError("Zyklische oder zu lange AWS-Rollenkette.");
    visited.add(current);
    const entry = Object.hasOwn(profiles, current) ? profiles[current] : null;
    if (!entry) throw new AuthError("AWS-Profil oder source_profile nicht gefunden.");
    if (entry.mfa_serial) throw new AuthError("Dieses Rollenprofil benoetigt MFA; der Tresor unterstuetzt derzeit keine MFA-Anmeldung.");
    if (!entry.role_arn) {
      if (!roles.length) throw new AuthError("Bitte ein AWS-Profil mit role_arn auswaehlen.");
      break; // Only the terminal credential source is replaced by the vault.
    }
    if (!/^arn:aws(?:-[a-z-]+)?:iam::\d{12}:role\/[\w+=,.@/\-]{1,512}$/.test(entry.role_arn)) {
      throw new AuthError("Ungueltige Rollen-ARN im AWS-Profil.");
    }
    if (entry.web_identity_token_file || (entry.source_profile && entry.credential_source)) {
      throw new AuthError("Nicht unterstuetzte oder mehrdeutige Rollenquelle.");
    }
    const duration = entry.duration_seconds === undefined ? 3600 : Number(entry.duration_seconds);
    if (!Number.isInteger(duration) || duration < 900 || duration > 43200) throw new AuthError("Ungueltige Rollensitzungsdauer.");
    if (entry.role_session_name && !/^[\w+=,.@-]{2,64}$/.test(entry.role_session_name)) throw new AuthError("Ungueltiger Rollensitzungsname.");
    if (entry.external_id && !/^[\w+=,.@:/-]{2,1224}$/.test(entry.external_id)) throw new AuthError("Ungueltige External ID.");
    roles.push({
      RoleArn: entry.role_arn, RoleSessionName: entry.role_session_name || "bedrock-chat",
      DurationSeconds: duration, ...(entry.external_id && { ExternalId: entry.external_id })
    });
    current = entry.source_profile || null;
    if (current) validateProfile(current);
  }
  return roles.reverse();
}

export function safeAwsError(err) {
  if (err instanceof AuthError) return err.message;
  const names = {
    AccessDeniedException: "AWS-Zugriff verweigert. Rollenberechtigung und Vertrauensrichtlinie pruefen.",
    AccessDenied: "AWS-Zugriff verweigert. Rollenberechtigung und Vertrauensrichtlinie pruefen.",
    InvalidClientTokenId: "AWS-Zugangsdaten sind ungueltig.",
    SignatureDoesNotMatch: "AWS-Zugangsdaten sind ungueltig.",
    ExpiredToken: "AWS-Sitzung ist abgelaufen.",
    CredentialsProviderError: "AWS-Zugangsdaten fehlen oder die Profilsitzung muss erneuert werden.",
    AbortError: "AWS-Anfrage abgebrochen.",
    ValidationException: "AWS hat die Anfrage abgelehnt. Modell, Region und Inferenzparameter pruefen.",
    ThrottlingException: "AWS-Anfragelimit erreicht. Bitte kurz warten.",
    ServiceUnavailableException: "AWS-Dienst momentan nicht erreichbar."
  };
  return names[err?.name] || "AWS-Anmeldung oder Verbindung fehlgeschlagen. Profil, Berechtigungen und Netzwerk pruefen.";
}

export class AuthService extends EventEmitter {
  constructor({ vault = new CredentialVault(), mode, profile, region, now = Date.now,
    profiles = readAwsProfiles, temporary = fromTemporaryCredentials,
    identityClient = (config) => new STSClient(config),
    savedMode = readSavedAuthMode(), persistMode = writeSavedAuthMode, env = process.env } = {}) {
    super();
    this.vault = vault;
    this.now = now;
    this.profiles = profiles;
    this.temporary = temporary;
    this.identityClient = identityClient;
    this.persistMode = persistMode;
    this.env = env;
    let exists = true;
    try { exists = vault.exists(); } catch { /* Keep damaged vault reachable for reset. */ }
    this.mode = mode || (profile ? "aws" : savedMode || (exists ? "vault" : "aws"));
    this.profile = profile || env.AWS_PROFILE || "default";
    this.explicitProfile = Boolean(profile);
    this.profileOverride = mode === "vault" ? profile : null;
    this.regionOverride = region || env.AWS_REGION || env.AWS_DEFAULT_REGION;
    this.region = this.regionOverride || "us-east-1";
    this.identityLabel = "";
    this.connection = "unchecked";
    this.session = null;
    this.provider = null;
    this.epoch = 0;
    this.mutating = false;
    this.operations = new Set();
    this.clients = new Set();
    this.clearCredentials = new Set();
    this.lastActivity = now();
    this.failures = 0;
    this.retryAt = 0;
    this.generationAbort = new AbortController();
    this.credentialAbort = new AbortController();
    this.timer = setInterval(() => this.checkIdle(), 1000);
    this.timer.unref?.();
  }

  status() {
    this.checkIdle();
    let exists = true;
    let storageError = false;
    try { exists = this.vault.exists(); } catch { storageError = true; }
    return {
      mode: this.mode, exists, storageError, locked: !this.session,
      ready: this.mode === "aws" || Boolean(this.session),
      profile: this.mode === "vault" && !this.session ? "" : this.profile,
      region: this.region, identityLabel: this.identityLabel, connection: this.connection,
      busy: this.operations.size > 0 || this.mutating, idleMinutes: 15
    };
  }

  checkIdle() {
    if (this.session && !this.operations.size && this.now() - this.lastActivity >= IDLE_MS) this.lock();
  }

  touch() {
    this.checkIdle();
    this.lastActivity = this.now();
  }

  invalidate() {
    this.epoch++;
    this.generationAbort.abort();
    this.credentialAbort.abort();
    this.generationAbort = new AbortController();
    for (const operation of this.operations) operation.abort();
    for (const client of this.clients) client.destroy?.();
    this.clients.clear();
    for (const clear of this.clearCredentials) clear();
    this.clearCredentials.clear();
    this.provider = null;
    this.identityLabel = "";
    this.connection = "unchecked";
    this.emit("change");
  }

  lock() {
    disposeSecrets(this.session);
    this.session = null;
    this.invalidate();
  }

  close() { clearInterval(this.timer); this.lock(); }

  assertGeneration(epoch) {
    if (this.epoch !== epoch) throw new AuthError("Anmeldung wurde gesperrt oder geaendert.", 423);
  }

  assertReady() {
    this.checkIdle();
    if (this.mutating) throw new AuthError("AWS-Einstellungen werden gerade geaendert.", 409);
    if (this.mode === "vault" && !this.session) throw new AuthError("Tresor gesperrt. Bitte mit Masterpasswort entsperren.", 423);
  }

  begin({ signal } = {}) {
    this.assertReady();
    this.touch();
    const controller = new AbortController();
    if (this.credentialAbort.signal.aborted) this.credentialAbort = new AbortController();
    const epoch = this.epoch;
    this.operations.add(controller);
    const cancel = () => {
      controller.abort();
      if ([...this.operations].every((operation) => operation.signal.aborted)) this.credentialAbort.abort();
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    return {
      signal: controller.signal, epoch, cancel,
      finish: () => {
        signal?.removeEventListener("abort", cancel);
        this.operations.delete(controller);
        if (!this.operations.size) this.credentialAbort.abort();
        this.lastActivity = this.now();
      }
    };
  }

  async exclusive(action) {
    this.checkIdle();
    if (this.mutating || this.operations.size) throw new AuthError("AWS-Anfrage oder Aenderung laeuft noch. Erst beenden oder sperren.", 409);
    this.mutating = true;
    const epoch = this.epoch;
    try { return await action(epoch); }
    finally { this.mutating = false; this.touch(); }
  }

  async listProfiles({ rolesOnly = false } = {}) {
    const options = await this.profileOptions();
    return rolesOnly ? options.roleProfiles : options.profiles;
  }

  async profileOptions() {
    const entries = await this.profiles();
    const profiles = Object.keys(entries).filter((name) => /^[\w.@+=,-]{1,128}$/.test(name)).sort();
    return { profiles, roleProfiles: profiles.filter((name) => Boolean(entries[name].role_arn)) };
  }

  async validateRole(profile) {
    const profiles = await this.profiles();
    const roles = resolveRoleChain(profiles, profile);
    return { roles, region: this.regionOverride || profiles[profile].region || "us-east-1" };
  }

  saveMode(mode) {
    try { this.persistMode(mode); }
    catch { throw new AuthError("Anmeldeart konnte nicht gespeichert werden.", 500); }
  }

  async setup(data, password, confirmation) {
    return this.exclusive(async (epoch) => {
      if (this.vault.exists()) throw new AuthError("Tresor ist bereits eingerichtet.", 409);
      if (password !== confirmation) throw new AuthError("Masterpasswoerter stimmen nicht ueberein.");
      validateCredentials(data);
      const { region } = await this.validateRole(data.profile);
      const next = await this.vault.prepare(data, password);
      try {
        this.assertGeneration(epoch);
        this.saveMode("vault");
        this.vault.save(next, null);
        this.mode = "vault";
        this.adopt(next, region);
      } catch (err) { disposeSecrets(next); throw err; }
      return this.status();
    });
  }

  adopt(next, region = this.regionOverride || "us-east-1") {
    this.region = region;
    disposeSecrets(this.session);
    this.session = next;
    this.profile = this.profileOverride || next.data.profile;
    this.invalidate();
    this.lastActivity = this.now();
  }

  async unlock(password) {
    return this.exclusive(async (epoch) => {
      if (this.now() < this.retryAt) throw new AuthError("Zu viele Entsperrversuche. Bitte kurz warten.", 429);
      let next;
      try {
        next = await this.vault.unlock(password);
        this.assertGeneration(epoch);
        if (this.vault.currentRevision() !== next.revision) throw new AuthError("Tresor wurde zwischenzeitlich geaendert. Bitte erneut entsperren.", 409);
        this.saveMode("vault");
        const profiles = await this.profiles().catch(() => ({}));
        this.assertGeneration(epoch);
        this.mode = "vault";
        this.adopt(next, this.regionOverride || profiles[this.profileOverride || next.data.profile]?.region || "us-east-1");
        this.failures = 0;
        this.retryAt = 0;
      } catch (err) {
        disposeSecrets(next);
        if (err.status === 401) {
          this.failures++;
          this.retryAt = this.now() + Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
        }
        throw err;
      }
      return this.status();
    });
  }

  async update(data) {
    return this.exclusive(async (epoch) => {
      if (!this.session) throw new AuthError("Tresor gesperrt.", 423);
      validateCredentials(data);
      const { region } = await this.validateRole(data.profile);
      this.assertGeneration(epoch);
      const next = { ...this.session, data: { ...data }, key: Buffer.from(this.session.key) };
      try { this.vault.save(next, this.session.revision); }
      catch (err) { disposeSecrets(next); throw err; }
      this.profileOverride = null;
      this.adopt(next, region);
      return this.status();
    });
  }

  async changePassword(oldPassword, password, confirmation) {
    return this.exclusive(async (epoch) => {
      if (!this.session) throw new AuthError("Tresor gesperrt.", 423);
      if (password !== confirmation) throw new AuthError("Masterpasswoerter stimmen nicht ueberein.");
      const current = await this.vault.unlock(oldPassword);
      let next;
      try {
        this.assertGeneration(epoch);
        if (current.revision !== this.session.revision) throw new AuthError("Tresor wurde zwischenzeitlich geaendert. Bitte erneut entsperren.", 409);
        next = await this.vault.prepare(current.data, password);
        this.assertGeneration(epoch);
        this.vault.save(next, current.revision);
        this.adopt(next, this.region);
      } catch (err) { disposeSecrets(next); throw err; }
      finally { disposeSecrets(current); }
      return this.status();
    });
  }

  async remove(confirmation) {
    return this.exclusive(async () => {
      if (confirmation !== "TRESOR LOESCHEN") throw new AuthError("Loeschung muss mit TRESOR LOESCHEN bestaetigt werden.");
      this.vault.delete(this.session?.revision ?? this.vault.currentRevision());
      this.lock();
      return this.status();
    });
  }

  async selectMode(mode, profile) {
    return this.exclusive(async (epoch) => {
      if (!["aws", "vault"].includes(mode)) throw new AuthError("Anmeldeart muss aws oder vault sein.");
      let region = this.regionOverride || "us-east-1";
      if (profile !== undefined) {
        validateProfile(profile);
        const profiles = await this.profiles();
        if (!Object.hasOwn(profiles, profile)) throw new AuthError("AWS-Profil nicht gefunden.");
        if (mode === "vault") resolveRoleChain(profiles, profile);
        region = this.regionOverride || profiles[profile].region || "us-east-1";
      }
      this.assertGeneration(epoch);
      this.saveMode(mode);
      this.lock();
      this.mode = mode;
      this.profile = profile || this.env.AWS_PROFILE || "default";
      this.region = region;
      this.explicitProfile = Boolean(profile);
      this.profileOverride = mode === "vault" ? profile : null;
      return this.status();
    });
  }

  async changeProfile(profile) {
    if (this.mode === "aws") return this.selectMode("aws", profile);
    if (!this.session) throw new AuthError("Tresor gesperrt.", 423);
    return this.update({ ...this.session.data, profile });
  }

  async clientConfig() {
    this.assertReady();
    const epoch = this.epoch;
    if (!this.provider) {
      const profiles = await this.profiles();
      this.assertGeneration(epoch);
      this.region = this.regionOverride || profiles[this.profile]?.region || "us-east-1";
      let provider;
      if (this.mode === "vault") {
        const roles = resolveRoleChain(profiles, this.profile);
        provider = async () => {
          this.assertGeneration(epoch);
          if (!this.session) throw new AuthError("Tresor gesperrt.", 423);
          return { accessKeyId: this.session.data.accessKeyId, secretAccessKey: this.session.data.secretAccessKey };
        };
        const transport = new NodeHttpHandler({ connectionTimeout: 5000, requestTimeout: 15000 });
        this.clients.add(transport);
        const signal = this.generationAbort.signal;
        const requestHandler = {
          handle: (request, options) => transport.handle(request, {
            ...options, abortSignal: combineAbortSignals([signal, this.credentialAbort.signal])
          }),
          destroy: () => transport.destroy()
        };
        for (const params of roles) {
          const temporary = this.temporary({ masterCredentials: provider, params,
            clientConfig: { region: this.region, maxAttempts: 2, requestHandler } });
          // Share refreshed role sessions across Bedrock, STS and Billing clients.
          let cached;
          let pending;
          this.clearCredentials.add(() => {
            if (cached) {
              cached.accessKeyId = "";
              cached.secretAccessKey = "";
              cached.sessionToken = "";
            }
            cached = null;
          });
          provider = async () => {
            this.assertGeneration(epoch);
            if (!cached || !cached.expiration || cached.expiration.getTime() - this.now() < 60_000) {
              pending ??= temporary().then((value) => {
                this.assertGeneration(epoch);
                cached = value;
                return value;
              }).finally(() => { pending = null; });
              await pending;
            }
            this.assertGeneration(epoch);
            return cached;
          };
        }
      } else {
        provider = this.explicitProfile ? fromIni({ profile: this.profile }) : fromNodeProviderChain();
      }
      const underlying = provider;
      this.provider = async (...args) => {
        this.assertGeneration(epoch);
        this.assertReady();
        const value = await underlying(...args);
        this.assertGeneration(epoch);
        return value;
      };
    }
    return { region: this.region, credentials: this.provider, maxAttempts: 2 };
  }

  track(client) { this.clients.add(client); return client; }

  async checkConnection() {
    const operation = this.begin();
    let client;
    try {
      client = this.track(this.identityClient(await this.clientConfig()));
      const identity = await client.send(new GetCallerIdentityCommand({}), { abortSignal: combineAbortSignals([operation.signal, AbortSignal.timeout(15000)]) });
      this.assertGeneration(operation.epoch);
      this.identityLabel = formatAwsIdentity(identity);
      this.connection = "connected";
      return this.status();
    } catch (err) {
      if (this.epoch === operation.epoch) this.connection = "failed";
      throw new AuthError(safeAwsError(err), err.status || 502);
    } finally {
      client?.destroy?.();
      this.clients.delete(client);
      operation.finish();
    }
  }
}
