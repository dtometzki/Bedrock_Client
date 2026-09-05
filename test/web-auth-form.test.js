import assert from "node:assert/strict";
import { test } from "node:test";
import { initAuthForm } from "../src/web/auth-form.js";
import { validatePassword } from "../src/credential-vault.js";

function fixture(action = "setup") {
  const elements = new Map();
  let focused;
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", type: "password", checked: false, textContent: "", listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      focus() { focused = id; }
    });
    return elements.get(id);
  };
  const submissions = [];
  const clear = initAuthForm(element, { isWorking: () => false, submit: (action, body) => { submissions.push({ action, body }); clear(); } });
  const values = { authAction: action, authProfile: "Admins", authAccess: "AKIAEXAMPLEONLY000001", authSecret: "s".repeat(40),
    authPassword: "valid-master-passphrase", authConfirm: "valid-master-passphrase", authOld: "previous-master-passphrase" };
  for (const [id, value] of Object.entries(values)) element(id).value = value;
  return { element, clear, values, submissions, focus: () => focused,
    send: () => element("authForm").listeners.submit({ preventDefault() {} }),
    reveal: (checked) => { element("authReveal").checked = checked; element("authReveal").listeners.change(); } };
}

test("short master password preserves pasted keys; correction submits once and clears secrets", () => {
  const f = fixture();
  f.element("authPassword").value = "short";
  f.element("authConfirm").value = "short";
  f.reveal(true);
  f.send();
  assert.equal(f.submissions.length, 0);
  assert.equal(f.focus(), "authPassword");
  assert.match(f.element("authFeedback").textContent, /mindestens 12 Zeichen/);
  for (const id of ["authAccess", "authSecret", "authProfile"]) assert.equal(f.element(id).value, f.values[id]);
  assert.equal(f.element("authPassword").value, "short");
  assert.equal(f.element("authConfirm").value, "short");
  f.element("authPassword").value = f.values.authPassword;
  f.element("authConfirm").value = f.values.authConfirm;
  f.send();
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].body.secretAccessKey, f.values.authSecret);
  for (const id of ["authAccess", "authSecret", "authPassword", "authConfirm"]) {
    assert.equal(f.element(id).value, "");
    assert.equal(f.element(id).type, "password");
  }
  assert.equal(f.element("authReveal").checked, false);
});

test("visibility reveals exact pasted text without submitting and resets on clearing", () => {
  const f = fixture();
  const pasted = " abc+/= ";
  f.element("authSecret").value = pasted;
  f.reveal(true);
  for (const id of ["authAccess", "authSecret", "authOld", "authPassword", "authConfirm"]) assert.equal(f.element(id).type, "text");
  assert.equal(f.element("authSecret").value, pasted);
  assert.equal(f.submissions.length, 0);
  f.reveal(false);
  assert.equal(f.element("authSecret").type, "password");
  assert.equal(f.element("authSecret").value, pasted);
  f.reveal(true);
  f.clear();
  assert.equal(f.element("authReveal").checked, false);
  assert.equal(f.element("authSecret").value, "");
  assert.equal(f.element("authSecret").type, "password");
});

test("password confirmation and password change validation preserve all inputs", () => {
  for (const action of ["setup", "password"]) {
    const f = fixture(action);
    f.element("authConfirm").value = "different-passphrase";
    f.send();
    assert.equal(f.submissions.length, 0);
    assert.equal(f.focus(), "authConfirm");
    assert.equal(f.element("authPassword").value, f.values.authPassword);
    assert.equal(f.element("authOld").value, f.values.authOld);
    f.element("authConfirm").value = f.values.authConfirm;
    f.send();
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0].action, action);
  }
});

test("browser password validation agrees with server character and UTF-8 limits", () => {
  for (const password of ["😀".repeat(6), "😀".repeat(12), "😀".repeat(257), "a".repeat(12), "a".repeat(1025), "valid-passphrase\n"]) {
    const f = fixture("unlock");
    f.element("authPassword").value = password;
    let valid = true;
    try { validatePassword(password); } catch { valid = false; }
    f.send();
    assert.equal(f.submissions.length, valid ? 1 : 0);
    if (!valid) assert.equal(f.element("authPassword").value, password);
  }
});

test("invalid pasted keys stay editable and do not reach the server", () => {
  for (const [id, value] of [["authAccess", "ASIAEXAMPLEONLY000001"], ["authAccess", " AKIAEXAMPLEONLY000001"], ["authSecret", "s".repeat(39)]]) {
    const f = fixture();
    f.element(id).value = value;
    f.send();
    assert.equal(f.submissions.length, 0);
    assert.equal(f.element(id).value, value);
    assert.equal(f.focus(), id);
    f.element(id).value = f.values[id];
    f.send();
    assert.equal(f.submissions.length, 1);
  }
});
