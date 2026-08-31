(() => {
  "use strict";

  // Der Server erwartet bei aktiviertem Auth-Token dessen Wert in jedem
  // API-Request. Die Seite wird beim ersten Aufruf mit #token=... geladen;
  // danach lebt das Token nur noch in sessionStorage (uebersteht Reloads,
  // endet mit dem Tab) und wird als Header bei jedem fetch mitgesendet.
  const TOKEN_STORAGE_KEY = "bedrock-chat-token";
  const fragmentToken = new URLSearchParams(location.hash.replace(/^#/, "")).get("token") || "";
  // Query-Token nur noch fuer alte Links akzeptieren. Neue Starts verwenden
  // das Fragment, das bei der HTTP-Anfrage nicht an den Server gesendet wird.
  const queryToken = new URLSearchParams(location.search).get("token") || "";
  const urlToken = fragmentToken || queryToken;
  let storedToken = "";
  try {
    if (urlToken) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
    } else {
      storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
    }
  } catch {
    // sessionStorage nicht verfuegbar (z. B. blockiert): Nur URL-Token nutzen,
    // ein Reload ohne ?token= verliert dann die API-Berechtigung.
  }
  const AUTH_TOKEN = urlToken || storedToken;

  // Token aus der Adresszeile entfernen, damit es nicht in der Browser-History
  // oder in kopierten Links landet. Reloads funktionieren ueber sessionStorage,
  // die Index-Seite selbst ist serverseitig ohne Token erreichbar.
  if (urlToken && window.history?.replaceState) {
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete("token");
    cleanUrl.hash = "";
    window.history.replaceState(null, "", cleanUrl.toString());
  }

  function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (AUTH_TOKEN) headers["x-bedrock-token"] = AUTH_TOKEN;
    return fetch(url, { ...options, headers });
  }

  const el = {
    messages: document.getElementById("messages"),
    empty: document.getElementById("empty"),
    main: document.getElementById("main"),
    input: document.getElementById("input"),
    sendBtn: document.getElementById("sendBtn"),
    stopBtn: document.getElementById("stopBtn"),
    clearBtn: document.getElementById("clearBtn"),
    systemBtn: document.getElementById("systemBtn"),
    modelSelect: document.getElementById("modelSelect"),
    effortSelect: document.getElementById("effortSelect"),
    accountChip: document.getElementById("accountChip"),
    status: document.getElementById("status"),
    attachBtn: document.getElementById("attachBtn"),
    fileInput: document.getElementById("fileInput"),
    attachRow: document.getElementById("attachRow"),
    inputbox: document.getElementById("inputbox"),
    usageBtn: document.getElementById("usageBtn"),
    usageOverlay: document.getElementById("usageOverlay"),
    usageBody: document.getElementById("usageBody"),
    usageCloseBtn: document.getElementById("usageCloseBtn"),
    libNotice: document.getElementById("libNotice"),
    libNoticeText: document.getElementById("libNoticeText"),
    libNoticeClose: document.getElementById("libNoticeClose")
  };

  const MAX_ATTACHMENTS = 5;
  const MAX_ATTACHMENT_BYTES = 4.5 * 1000 * 1000;
  const EFFORT_LABELS = { low: "Niedrig", medium: "Mittel", high: "Hoch", max: "Max" };

  // Modelltext ist nicht vertrauenswuerdig. Eine enge Allowlist erhaelt die
  // uebliche Markdown-Formatierung, entfernt aber insbesondere style-Tags,
  // style-Attribute, Formulare und andere interaktive HTML-Elemente. Sonst
  // koennte eine manipulierte Modellantwort die gesamte GUI ueberdecken oder
  // Bedienelemente vortaeuschen.
  const MARKDOWN_ALLOWED_TAGS = Object.freeze([
    "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "img", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead",
    "tr", "ul"
  ]);
  const MARKDOWN_ALLOWED_ATTRS = Object.freeze([
    "align", "alt", "href", "src", "start", "title"
  ]);

  let busy = false;
  let currentSystemPrompt = "";
  let pendingAttachments = [];
  let effortSupported = false;

  // Beide Bibliotheken liegen lokal unter /vendor/ und werden vom eigenen
  // Server ausgeliefert. Fehlt eine trotzdem (z. B. unvollstaendige
  // Installation), rendern wir sicher als Klartext statt roher HTML.
  const markdownReady = Boolean(window.marked && window.DOMPurify);

  function renderMarkdown(text) {
    if (markdownReady) {
      return DOMPurify.sanitize(marked.parse(text), {
        ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
        ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTRS
      });
    }
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML.replace(/\n/g, "<br>");
  }

  // Zeigt einmalig eine gut sichtbare Meldung, wenn die Markdown-Bibliotheken
  // nicht geladen werden konnten. Der Chat bleibt voll nutzbar (Klartext).
  function checkMarkdownLibs() {
    if (markdownReady) return;
    const missing = [!window.marked && "marked", !window.DOMPurify && "DOMPurify"]
      .filter(Boolean)
      .join(" und ");
    el.libNoticeText.textContent =
      "Formatierung eingeschraenkt: " + missing + " konnte nicht geladen werden. " +
      "Antworten werden als Klartext angezeigt. Die Dateien werden lokal unter " +
      "/vendor/ ausgeliefert; vermutlich ist die Installation unvollstaendig. " +
      "Der Chat funktioniert normal weiter.";
    el.libNotice.classList.add("show");
  }

  function scrollToBottom() {
    el.main.scrollTop = el.main.scrollHeight;
  }

  function hideEmpty() {
    if (el.empty) { el.empty.remove(); el.empty = null; }
  }

  function addUserMessage(text, attachmentNames) {
    hideEmpty();
    const wrap = document.createElement("div");
    wrap.className = "msg user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "(nur Anhang)";
    wrap.appendChild(bubble);
    if (attachmentNames && attachmentNames.length) {
      const row = document.createElement("div");
      row.className = "attachments";
      attachmentNames.forEach((name) => {
        const chip = document.createElement("span");
        chip.className = "filechip";
        chip.innerHTML = "📎 <span class=\"name\"></span>";
        chip.querySelector(".name").textContent = name;
        row.appendChild(chip);
      });
      bubble.after(row);
    }
    el.messages.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  function renderAttachRow() {
    el.attachRow.innerHTML = "";
    pendingAttachments.forEach((attachment, index) => {
      const chip = document.createElement("span");
      chip.className = "filechip";
      chip.innerHTML = "📎 <span class=\"name\"></span><span class=\"remove\" title=\"Entfernen\">×</span>";
      chip.querySelector(".name").textContent = attachment.name;
      chip.querySelector(".remove").addEventListener("click", () => {
        pendingAttachments.splice(index, 1);
        renderAttachRow();
      });
      el.attachRow.appendChild(chip);
    });
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(new Error("Datei konnte nicht gelesen werden: " + file.name));
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(fileList) {
    if (busy) {
      alert("Während einer laufenden Anfrage können keine Anhänge hinzugefügt werden.");
      return;
    }
    for (const file of fileList) {
      if (pendingAttachments.length >= MAX_ATTACHMENTS) {
        alert("Maximal " + MAX_ATTACHMENTS + " Anhänge pro Nachricht.");
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        alert("Datei zu groß (max. 4,5 MB): " + file.name);
        continue;
      }
      try {
        const dataBase64 = await readFileAsBase64(file);
        pendingAttachments.push({ name: file.name, dataBase64 });
      } catch (err) {
        alert(err.message);
      }
    }
    renderAttachRow();
  }

  function addAssistantMessage() {
    hideEmpty();
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    const content = document.createElement("div");
    content.className = "content";
    wrap.appendChild(content);
    el.messages.appendChild(wrap);
    return { wrap, content };
  }

  function setBusy(value) {
    busy = value;
    el.sendBtn.disabled = value;
    el.stopBtn.style.display = value ? "" : "none";
    el.modelSelect.disabled = value;
    el.effortSelect.disabled = value || !effortSupported;
    el.clearBtn.disabled = value;
    el.systemBtn.disabled = value;
    el.attachBtn.disabled = value;
    if (!value) el.status.textContent = "";
  }

  function formatUsd(value) {
    return value == null ? "n/a" : "$" + value.toFixed(4);
  }

  function applyEffort(state) {
    const model = state.models.find((entry) => entry.id === state.modelId);
    const config = model && model.effort;
    el.effortSelect.innerHTML = "";
    effortSupported = Boolean(config);

    if (!config) {
      const option = document.createElement("option");
      option.textContent = "Effort n/a";
      el.effortSelect.appendChild(option);
      el.effortSelect.disabled = true;
      el.effortSelect.title = "Dieses Modell unterstützt kein Effort Level";
      return;
    }

    el.effortSelect.title = "Effort Level (Denk-Aufwand)";
    config.levels.forEach((level) => {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = "Effort: " + (EFFORT_LABELS[level] || level);
      option.selected = level === state.effort;
      el.effortSelect.appendChild(option);
    });
    el.effortSelect.disabled = busy;
  }

  function applyState(state) {
    el.modelSelect.innerHTML = "";
    state.models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      option.selected = model.id === state.modelId;
      el.modelSelect.appendChild(option);
    });
    applyEffort(state);
    const account = [state.profile, state.region, state.identityLabel]
      .filter(Boolean).join(" · ");
    el.accountChip.textContent = account || "–";
    currentSystemPrompt = state.systemPrompt || "";
    el.messages.querySelectorAll(".msg").forEach((node) => node.remove());
    if (state.messages.length) hideEmpty();
    state.messages.forEach((message) => {
      if (message.role === "user") {
        addUserMessage(message.text, message.attachments);
      } else {
        const { content } = addAssistantMessage();
        content.innerHTML = renderMarkdown(message.text);
      }
    });
    scrollToBottom();
  }

  async function loadState() {
    const response = await apiFetch("/api/state");
    applyState(await response.json());
  }

  async function postJson(url, payload) {
    const response = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  }

  async function sendMessage() {
    const text = el.input.value.trim();
    if ((!text && !pendingAttachments.length) || busy) return;

    const attachments = pendingAttachments;
    pendingAttachments = [];
    renderAttachRow();
    el.input.value = "";
    el.input.style.height = "auto";
    el.status.textContent = "";
    setBusy(true);
    const userWrap = addUserMessage(text, attachments.map((attachment) => attachment.name));

    const { wrap: assistantWrap, content } = addAssistantMessage();
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    content.appendChild(cursor);
    scrollToBottom();

    let answer = "";
    let reasoning = "";
    let reasoningEl = null;
    let meta = null;
    let failureMessage = "";

    const renderAnswer = () => {
      content.innerHTML = renderMarkdown(answer);
      content.appendChild(cursor);
    };

    const handleEvent = (event) => {
      if (event.type === "text") {
        answer += event.text;
        renderAnswer();
      } else if (event.type === "reasoning") {
        if (!reasoningEl) {
          reasoningEl = document.createElement("details");
          reasoningEl.className = "reasoning";
          reasoningEl.innerHTML = "<summary>Reasoning</summary><pre></pre>";
          content.parentNode.insertBefore(reasoningEl, content);
        }
        reasoning += event.text;
        reasoningEl.querySelector("pre").textContent = reasoning;
      } else if (event.type === "retry") {
        el.status.textContent = "Erneuter Versuch " + event.attempt + "/" +
          event.maxRetries + " in " + event.delayMs + " ms…";
      } else if (event.type === "error") {
        failureMessage = "API Fehler: " + event.message;
        const box = document.createElement("div");
        box.className = "error";
        box.textContent = failureMessage;
        content.parentNode.appendChild(box);
      } else if (event.type === "done") {
        meta = event;
      }
      scrollToBottom();
    };

    try {
      const response = await apiFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, attachments: attachments })
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || response.statusText);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          try {
            handleEvent(JSON.parse(line.slice(5)));
          } catch {}
        }
      }
      if (!meta && !failureMessage) {
        failureMessage = "Verbindung beendet, bevor die Antwort bestätigt wurde.";
      }
    } catch (err) {
      failureMessage = "Fehler: " + err.message;
      const box = document.createElement("div");
      box.className = "error";
      box.textContent = failureMessage;
      content.parentNode.appendChild(box);
    }

    cursor.remove();
    content.innerHTML = renderMarkdown(answer);

    if (failureMessage || (meta && meta.failed)) {
      userWrap.remove();
      assistantWrap.remove();
      if (!el.input.value) {
        el.input.value = text;
        el.input.dispatchEvent(new Event("input"));
      }
      pendingAttachments = [...attachments, ...pendingAttachments].slice(0, MAX_ATTACHMENTS);
      renderAttachRow();
      setBusy(false);
      await loadState().catch(() => {});
      el.status.textContent = failureMessage || "Nachricht konnte nicht gesendet werden.";
      scrollToBottom();
      el.input.focus();
      return;
    }

    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    const metaParts = [];
    if (meta && meta.aborted) metaParts.push("Antwort abgebrochen");
    if (meta && meta.usage) {
      metaParts.push(meta.usage.totalTokens.toLocaleString("de-DE") + " Tokens");
      metaParts.push("Schätzung " + formatUsd(meta.usage.costUsd));
      if (meta.usage.latencyMs) metaParts.push(meta.usage.latencyMs + " ms");
    }
    if (metaParts.length) {
      metaEl.textContent = metaParts.join(" · ");
      content.parentNode.appendChild(metaEl);
    }

    setBusy(false);
    scrollToBottom();
    el.input.focus();
  }

  async function abortRequest() {
    try { await postJson("/api/abort"); } catch {}
  }

  function formatInt(value) {
    return Number(value || 0).toLocaleString("de-DE");
  }

  function usageRow(label, value) {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.textContent = label;
    const valueCell = document.createElement("td");
    valueCell.textContent = value;
    row.append(labelCell, valueCell);
    return row;
  }

  function usageSection(title, rows) {
    const heading = document.createElement("h3");
    heading.textContent = title;
    const table = document.createElement("table");
    rows.forEach((row) => table.appendChild(row));
    return [heading, table];
  }

  function renderUsage(data) {
    el.usageBody.innerHTML = "";
    const billing = data.billing || {};
    const session = data.session || {};

    const billingRows = billing.error
      ? [usageRow("Kosten", "n/a"), usageRow("Hinweis", billing.error.split("\n")[0])]
      : [
          usageRow("Kosten", formatUsd(billing.amount) + " " + (billing.unit || "USD") +
            (billing.estimated ? " (AWS Estimated)" : "")),
          usageRow("Zeitraum", billing.period ? billing.period.label : "–")
        ];
    el.usageBody.append(...usageSection("AWS Billing (Bedrock, aktueller Monat)", billingRows));

    if (!session.requests) {
      const note = document.createElement("p");
      note.textContent = "Noch keine Bedrock-Nutzung in dieser Session.";
      el.usageBody.appendChild(note);
    } else {
      if (session.last) {
        el.usageBody.append(...usageSection("Letzte Antwort (" + session.last.modelLabel + ")", [
          usageRow("Input", formatInt(session.last.inputTokens) + " Tokens"),
          usageRow("Output", formatInt(session.last.outputTokens) + " Tokens"),
          usageRow("Gesamt", formatInt(session.last.totalTokens) + " Tokens"),
          usageRow("Schätzung", formatUsd(session.last.costUsd)),
          usageRow("Latenz", session.last.latencyMs ? session.last.latencyMs + " ms" : "n/a")
        ]));
      }
      el.usageBody.append(...usageSection("Session (" + formatInt(session.requests) + " Requests)", [
        usageRow("Input", formatInt(session.inputTokens) + " Tokens"),
        usageRow("Output", formatInt(session.outputTokens) + " Tokens"),
        usageRow("Gesamt", formatInt(session.totalTokens) + " Tokens"),
        usageRow("Schätzung", formatUsd(session.costUsd))
      ]));
      if (session.byModel && session.byModel.length > 1) {
        el.usageBody.append(...usageSection("Nach Modell", session.byModel.map((entry) =>
          usageRow(entry.modelLabel, formatInt(entry.totalTokens) + " Tokens, " +
            formatUsd(entry.costUsd) + (entry.hasUnknownCost ? "+" : ""))
        )));
      }
    }

    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "Session-Kosten sind eine Token-Schätzung; AWS Billing ist der Cost-Explorer-Wert für Amazon Bedrock.";
    el.usageBody.appendChild(note);
  }

  async function openUsage() {
    el.usageOverlay.style.display = "";
    el.usageBody.textContent = "Lade… (AWS Cost Explorer kann einige Sekunden brauchen)";
    try {
      const response = await apiFetch("/api/usage");
      if (!response.ok) throw new Error(response.statusText);
      renderUsage(await response.json());
    } catch (err) {
      el.usageBody.textContent = "Usage konnte nicht geladen werden: " + err.message;
    }
  }

  el.sendBtn.addEventListener("click", sendMessage);
  el.stopBtn.addEventListener("click", abortRequest);
  el.usageBtn.addEventListener("click", openUsage);
  el.usageCloseBtn.addEventListener("click", () => { el.usageOverlay.style.display = "none"; });
  el.usageOverlay.addEventListener("click", (event) => {
    if (event.target === el.usageOverlay) el.usageOverlay.style.display = "none";
  });

  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", async () => {
    await addFiles(Array.from(el.fileInput.files));
    el.fileInput.value = "";
  });
  el.inputbox.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.inputbox.classList.add("dragover");
  });
  el.inputbox.addEventListener("dragleave", () => el.inputbox.classList.remove("dragover"));
  el.inputbox.addEventListener("drop", async (event) => {
    event.preventDefault();
    el.inputbox.classList.remove("dragover");
    if (event.dataTransfer?.files?.length) {
      await addFiles(Array.from(event.dataTransfer.files));
    }
  });

  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (el.usageOverlay.style.display !== "none") {
        el.usageOverlay.style.display = "none";
      } else if (busy) {
        abortRequest();
      }
    }
  });
  el.input.addEventListener("input", () => {
    el.input.style.height = "auto";
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
  });

  el.modelSelect.addEventListener("change", async () => {
    try {
      const state = await postJson("/api/model", { model: el.modelSelect.value });
      applyState(state);
    } catch (err) {
      alert(err.message);
      loadState();
    }
  });

  el.effortSelect.addEventListener("change", async () => {
    try {
      applyState(await postJson("/api/effort", { effort: el.effortSelect.value }));
    } catch (err) {
      alert(err.message);
      loadState();
    }
  });

  el.clearBtn.addEventListener("click", async () => {
    if (!confirm("Verlauf wirklich leeren?")) return;
    try {
      applyState(await postJson("/api/clear"));
    } catch (err) {
      alert(err.message);
    }
  });

  el.systemBtn.addEventListener("click", async () => {
    const value = prompt("System Prompt (leer = kein System Prompt):", currentSystemPrompt);
    if (value === null) return;
    try {
      applyState(await postJson("/api/system", { system: value }));
    } catch (err) {
      alert(err.message);
    }
  });

  el.libNoticeClose.addEventListener("click", () => {
    el.libNotice.classList.remove("show");
  });

  checkMarkdownLibs();
  loadState().catch((err) => {
    el.status.textContent = "Status konnte nicht geladen werden: " + err.message;
  });
  el.input.focus();
})();
