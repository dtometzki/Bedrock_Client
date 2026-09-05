import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { getConfigDir } from "./config.js";

const derive = promisify(scrypt);
const KDF = Object.freeze({ N: 131072, r: 8, p: 1 });
const MAX_BYTES = 16_384;
const AAD = Buffer.from("bedrock-chat:credentials:v1");

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validatePassword(password) {
  if (typeof password !== "string" || [...password].length < 12 || Buffer.byteLength(password) > 1024 || /[\x00-\x1f\x7f]/.test(password)) {
    throw new AuthError("Masterpasswort muss mindestens 12 Zeichen enthalten, maximal 1024 Bytes lang sein und darf keine Steuerzeichen enthalten.");
  }
}

export function validateProfile(profile) {
  if (typeof profile !== "string" || !/^[\w.@+=,-]{1,128}$/.test(profile)) {
    throw new AuthError("Ungueltiger AWS-Profilname (maximal 128 Zeichen).");
  }
}

export function validateCredentials(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      Object.keys(data).some((key) => !["accessKeyId", "secretAccessKey", "profile"].includes(key))) {
    throw new AuthError("Ungueltige Zugangsdaten.");
  }
  validateProfile(data.profile);
  if (typeof data.accessKeyId !== "string" || !/^[A-Z0-9]{16,128}$/.test(data.accessKeyId) ||
      typeof data.secretAccessKey !== "string" || !/^[A-Za-z0-9/+=]{40}$/.test(data.secretAccessKey)) {
    throw new AuthError("Access Key ID oder Secret Access Key hat ein ungueltiges Format.");
  }
  if (data.accessKeyId.startsWith("ASIA")) {
    throw new AuthError("Bitte dauerhafte Basisschluessel verwenden; temporaere Schluessel mit Session-Token werden nicht unterstuetzt.");
  }
}

function decode(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length && bytes.length !== length)) throw new Error();
  return bytes;
}

function parseEnvelope(raw) {
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1 || value.cipher !== "aes-256-gcm" || value.kdf?.name !== "scrypt" ||
        Object.entries(KDF).some(([key, expected]) => value.kdf[key] !== expected)) throw new Error();
    const ciphertext = decode(value.ciphertext);
    if (!ciphertext.length || ciphertext.length > 4096) throw new Error();
    return { salt: decode(value.salt, 16), iv: decode(value.iv, 12), tag: decode(value.tag, 16), ciphertext };
  } catch {
    throw new AuthError("Tresordatei beschaedigt oder Format nicht unterstuetzt.");
  }
}

function revision(raw) {
  return raw === null ? null : createHash("sha256").update(raw).digest("hex");
}

export function disposeSecrets(session) {
  session?.key?.fill(0);
  if (session?.data) {
    session.data.accessKeyId = "";
    session.data.secretAccessKey = "";
  }
}

// Cryptography and disk storage only. The auth service owns unlocked state.
export class CredentialVault {
  constructor(directory = getConfigDir()) {
    this.directory = directory;
    this.file = path.join(directory, "credentials.enc.json");
  }

  read() {
    let fd;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new AuthError("Tresordatei ungueltig oder zu gross.");
      // Bounded read even if another process grows the file after fstat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count > MAX_BYTES) throw new AuthError("Tresordatei zu gross.");
      return buffer.subarray(0, count).toString("utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      if (err instanceof AuthError) throw err;
      throw new AuthError("Tresordatei konnte nicht gelesen werden.", 500);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  exists() { return this.read() !== null; }

  async unlock(password) {
    validatePassword(password);
    const raw = this.read();
    if (raw === null) throw new AuthError("Noch kein Tresor eingerichtet.", 409);
    const value = parseEnvelope(raw);
    const key = await derive(password, value.salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
    let plaintext;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, value.iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(value.tag);
      plaintext = Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
      const data = JSON.parse(plaintext.toString("utf8"));
      validateCredentials(data);
      return { key, data, salt: value.salt, revision: revision(raw) };
    } catch {
      key.fill(0);
      throw new AuthError("Masterpasswort falsch oder Tresordatei beschaedigt.", 401);
    } finally {
      plaintext?.fill(0);
    }
  }

  async prepare(data, password) {
    validateCredentials(data);
    validatePassword(password);
    const salt = randomBytes(16);
    const key = await derive(password, salt, 32, { ...KDF, maxmem: 256 * 1024 * 1024 });
    return { key, salt, data: { ...data }, revision: null };
  }

  save(session, expectedRevision) {
    validateCredentials(session.data);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", session.key, iv);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(session.data));
    let ciphertext;
    try {
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    } finally {
      plaintext.fill(0);
    }
    const raw = JSON.stringify({
      version: 1, cipher: "aes-256-gcm", kdf: { name: "scrypt", ...KDF },
      salt: session.salt.toString("base64"), iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64")
    }) + "\n";
    this.commit(raw, expectedRevision);
    session.revision = revision(raw);
  }

  delete(expectedRevision) { this.commit(null, expectedRevision); }
  currentRevision() {
    try { return revision(this.read()); }
    catch {
      // An explicitly confirmed reset must also be possible for oversized or
      // unreadable vaults. lstat does not follow a replaced symlink.
      try {
        const stat = fs.lstatSync(this.file);
        return `unreadable:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
      } catch { throw new AuthError("Tresordatei konnte nicht geprueft werden.", 500); }
    }
  }

  commit(raw, expectedRevision) {
    const lock = `${this.file}.lock`;
    const tmp = `${this.file}.${randomBytes(12).toString("hex")}.tmp`;
    let locked = false;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.mkdirSync(lock, { mode: 0o700 });
      locked = true;
      if (this.currentRevision() !== expectedRevision) {
        throw new AuthError("Tresor wurde durch einen anderen Client geaendert. Bitte sperren und erneut entsperren.", 409);
      }
      if (raw === null) {
        fs.unlinkSync(this.file);
      } else {
        const fd = fs.openSync(tmp, "wx", 0o600);
        try {
          fs.writeFileSync(fd, raw, "utf8");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.file);
      }
    } catch (err) {
      if (err instanceof AuthError) throw err;
      if (err.code === "EEXIST") throw new AuthError("Ein anderer Client schreibt den Tresor. Bitte erneut versuchen. Bei verwaister Sperre alle Clients beenden und credentials.enc.json.lock entfernen.", 409);
      throw new AuthError(raw === null ? "Tresor konnte nicht geloescht werden." : "Tresor konnte nicht gespeichert werden.", 500);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      if (locked) fs.rmdirSync(lock);
    }
  }
}
