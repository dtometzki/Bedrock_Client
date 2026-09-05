const SECRET_FIELDS = ["authAccess", "authSecret", "authOld", "authPassword", "authConfirm"];

function passwordError(password) {
  if ([...password].length < 12) return "Das Masterpasswort muss mindestens 12 Zeichen enthalten. Deine Eingaben bleiben erhalten.";
  if (new TextEncoder().encode(password).length > 1024 || /[\x00-\x1f\x7f]/.test(password)) {
    return "Das Masterpasswort darf maximal 1024 Bytes lang sein und keine Steuerzeichen enthalten. Deine Eingaben bleiben erhalten.";
  }
  return null;
}

// Validate before submitting: secret fields are cleared only once a request is sent.
export function initAuthForm(element, { isWorking, submit }) {
  function setVisibility() {
    for (const id of SECRET_FIELDS) element(id).type = element("authReveal").checked ? "text" : "password";
  }
  function clearInputs() {
    for (const id of [...SECRET_FIELDS, "authDelete"]) element(id).value = "";
    element("authReveal").checked = false;
    setVisibility();
  }
  function invalid(id, message) {
    element("authFeedback").textContent = message;
    element(id).focus();
  }
  element("authReveal").addEventListener("change", setVisibility);
  element("authForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (isWorking()) return;
    const action = element("authAction").value;
    const body = {};
    if (["setup", "update", "profile"].includes(action)) {
      body.profile = element("authProfile").value;
      if (!body.profile) return invalid("authProfile", "Bitte ein passendes AWS-Profil auswählen. Deine Eingaben bleiben erhalten.");
    }
    if (["setup", "update"].includes(action)) {
      body.accessKeyId = element("authAccess").value;
      body.secretAccessKey = element("authSecret").value;
      if (!/^[A-Z0-9]{16,128}$/.test(body.accessKeyId) || body.accessKeyId.startsWith("ASIA")) {
        return invalid("authAccess", "Bitte eine dauerhafte Access Key ID mit 16 bis 128 Großbuchstaben/Ziffern eingeben. Deine Eingaben bleiben erhalten.");
      }
      if (!/^[A-Za-z0-9/+=]{40}$/.test(body.secretAccessKey)) {
        return invalid("authSecret", "Der Secret Access Key muss genau 40 gültige Zeichen enthalten (Buchstaben, Ziffern, /, +, =). Deine Eingaben bleiben erhalten.");
      }
    }
    if (["setup", "unlock", "password"].includes(action)) {
      body.password = element("authPassword").value;
      const error = passwordError(body.password);
      if (error) return invalid("authPassword", error);
    }
    if (["setup", "password"].includes(action)) {
      body.confirmation = element("authConfirm").value;
      if (body.password !== body.confirmation) return invalid("authConfirm", "Die Masterpasswörter stimmen nicht überein. Deine Eingaben bleiben erhalten.");
    }
    if (action === "password") {
      body.oldPassword = element("authOld").value;
      const error = passwordError(body.oldPassword);
      if (error) return invalid("authOld", "Bisheriges Masterpasswort: " + error);
    }
    if (action === "delete") body.confirmation = element("authDelete").value;
    if (action === "mode") {
      body.mode = element("authMode").value;
      if (body.mode === "aws" && element("authProfile").value) body.profile = element("authProfile").value;
    }
    submit(action, body);
  });
  return clearInputs;
}
