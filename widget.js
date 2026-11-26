/*
 * Budds Creek Group — self-hosted AI chat widget (frontend)
 * ----------------------------------------------------------
 * One self-contained vanilla-JS file. No dependencies.
 *
 * Embed it on any page with a script tag, e.g.:
 *
 *   <script src="https://YOUR-WORKER.workers.dev/widget.js"
 *           data-site="genealogy"
 *           data-endpoint="https://YOUR-WORKER.workers.dev"
 *           data-name="Genealogy Detective Service"
 *           data-color="#2e6b34"
 *           data-greeting="Hi! Questions about family history research? Ask me anything."></script>
 *
 * Configuration route (chosen for simplicity + robustness):
 * everything the widget needs for display lives in data attributes on the
 * script tag itself — no extra config fetch, no CORS round-trip before the
 * bubble can render. The *business facts / system prompt* live server-side
 * in the Worker's SITES object, keyed by data-site.
 *
 *   data-site     (required) site key understood by the backend
 *   data-endpoint (required) base URL of the Worker (no trailing slash)
 *   data-name     business name shown in the panel header
 *   data-color    accent color for bubble / header / buttons (hex)
 *   data-greeting first assistant message shown when the panel opens
 *
 * Behaviour:
 *   - Floating bubble, bottom-right. Opens a chat panel.
 *   - Conversation history is kept in memory only (resets on page reload).
 *   - POST {site, messages} -> {endpoint}/chat, expects {reply}.
 *   - "Leave your number" button opens a lead form inside the panel:
 *     POST {site, name, contact, need} -> {endpoint}/lead.
 *   - Typing indicator while waiting. Mobile-friendly panel sizing.
 *   - Rendered inside a Shadow DOM so host-page CSS can't break it
 *     (and it can't break the host page).
 */
(function () {
  "use strict";

  // ---- Read configuration from this script tag --------------------------
  var script = document.currentScript;
  if (!script) return;

  var SITE = script.getAttribute("data-site") || "";
  var ENDPOINT = (script.getAttribute("data-endpoint") || "").replace(/\/+$/, "");
  var NAME = script.getAttribute("data-name") || "Chat with us";
  var COLOR = script.getAttribute("data-color") || "#2e6b34";
  var GREETING =
    script.getAttribute("data-greeting") ||
    "Hi! How can I help you today?";

  if (!SITE || !ENDPOINT) {
    // Misconfigured embed — fail quietly rather than break the page.
    if (window.console) console.warn("[chat-widget] data-site and data-endpoint are required.");
    return;
  }

  // ---- Styles (scoped inside the shadow root) ---------------------------
  var CSS = [
    ":host { all: initial; }",
    "* { box-sizing: border-box; font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }",
    ".bubble {",
    "  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;",
    "  width: 60px; height: 60px; border-radius: 50%; border: none; cursor: pointer;",
    "  background: " + COLOR + "; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.28);",
    "  display: flex; align-items: center; justify-content: center;",
    "  transition: transform .15s ease;",
    "}",
    ".bubble:hover { transform: scale(1.06); }",
    ".bubble svg { width: 28px; height: 28px; }",
    ".panel {",
    "  position: fixed; right: 20px; bottom: 92px; z-index: 2147483000;",
    "  width: 360px; max-width: calc(100vw - 24px);",
    "  height: 520px; max-height: calc(100dvh - 120px);",
    "  background: #fff; border-radius: 14px; overflow: hidden;",
    "  box-shadow: 0 12px 40px rgba(0,0,0,.30);",
    "  display: none; flex-direction: column;",
    "}",
    ".panel.open { display: flex; }",
    ".header { background: " + COLOR + "; color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 10px; }",
    ".header .title { font-size: 15px; font-weight: 600; line-height: 1.25; }",
    ".header .sub { font-size: 12px; opacity: .85; }",
    ".header button { margin-left: auto; background: none; border: none; color: #fff; font-size: 20px; cursor: pointer; line-height: 1; padding: 2px 4px; }",
    ".messages { flex: 1; overflow-y: auto; padding: 14px; background: #f7f5f0; display: flex; flex-direction: column; gap: 8px; }",
    ".msg { max-width: 85%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }",
    ".msg.bot { background: #fff; border: 1px solid #e3ded2; align-self: flex-start; border-bottom-left-radius: 4px; }",
    ".msg.user { background: " + COLOR + "; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }",
    ".typing { align-self: flex-start; background: #fff; border: 1px solid #e3ded2; border-radius: 12px; padding: 10px 14px; display: none; }",
    ".typing span { display: inline-block; width: 7px; height: 7px; margin-right: 3px; border-radius: 50%; background: #b6ad97; animation: blink 1.2s infinite; }",
    ".typing span:nth-child(2) { animation-delay: .2s; }",
    ".typing span:nth-child(3) { animation-delay: .4s; margin-right: 0; }",
    "@keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }",
    ".leadbar { padding: 8px 12px; background: #fff; border-top: 1px solid #eee; }",
    ".leadbar button { width: 100%; background: #fff; color: " + COLOR + "; border: 1.5px solid " + COLOR + "; border-radius: 999px; padding: 7px 10px; font-size: 13.5px; font-weight: 600; cursor: pointer; }",
    ".leadbar button:hover { background: " + COLOR + "; color: #fff; }",
    ".leadform { display: none; padding: 12px 14px; background: #fff; border-top: 1px solid #eee; }",
    ".leadform.open { display: block; }",
    ".leadform h4 { margin: 0 0 8px; font-size: 14px; color: #333; }",
    ".leadform label { display: block; font-size: 12.5px; color: #555; margin: 8px 0 3px; }",
    ".leadform input, .leadform textarea { width: 100%; border: 1px solid #ccc; border-radius: 8px; padding: 8px 10px; font-size: 14px; }",
    ".leadform textarea { resize: vertical; min-height: 52px; }",
    ".leadform .send { margin-top: 10px; width: 100%; background: " + COLOR + "; color: #fff; border: none; border-radius: 8px; padding: 9px; font-size: 14px; font-weight: 600; cursor: pointer; }",
    ".leadform .note { font-size: 12px; color: #2e6b34; margin-top: 8px; display: none; }",
    ".leadform .err { font-size: 12px; color: #b03a2a; margin-top: 8px; display: none; }",
    ".composer { display: flex; gap: 8px; padding: 10px; background: #fff; border-top: 1px solid #eee; }",
    ".composer input { flex: 1; border: 1px solid #ccc; border-radius: 999px; padding: 9px 14px; font-size: 14px; }",
    ".composer button { background: " + COLOR + "; color: #fff; border: none; border-radius: 999px; padding: 9px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }",
    ".composer button:disabled, .composer input:disabled { opacity: .55; }",
    "@media (max-width: 480px) {",
    "  .panel { right: 12px; bottom: 88px; height: calc(100dvh - 110px); }",
    "  .bubble { right: 16px; bottom: 16px; }",
    "}"
  ].join("\n");

  // ---- Build DOM inside a shadow root -----------------------------------
  var host = document.createElement("div");
  host.setAttribute("aria-hidden", "false");
  var root = host.attachShadow({ mode: "open" });

  var style = document.createElement("style");
  style.textContent = CSS;
  root.appendChild(style);

  var wrap = document.createElement("div");
  wrap.innerHTML =
    '<button class="bubble" type="button" aria-label="Open chat with ' + escapeAttr(NAME) + '">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z"/></svg>' +
    "</button>" +
    '<section class="panel" role="dialog" aria-label="Chat with ' + escapeAttr(NAME) + '">' +
    '  <div class="header">' +
    "    <div>" +
    '      <div class="title">' + escapeHtml(NAME) + "</div>" +
    '      <div class="sub">Typically replies right away</div>' +
    "    </div>" +
    '    <button type="button" class="close" aria-label="Close chat">&times;</button>' +
    "  </div>" +
    '  <div class="messages" aria-live="polite"></div>' +
    '  <div class="typing" aria-hidden="true"><span></span><span></span><span></span></div>' +
    '  <div class="leadbar"><button type="button" class="leadopen">Leave your number &mdash; we&rsquo;ll reach out</button></div>' +
    '  <form class="leadform" novalidate>' +
    "    <h4>Tell us how to reach you</h4>" +
    '    <label for="lf-name">Your name</label>' +
    '    <input id="lf-name" name="name" type="text" autocomplete="name" required>' +
    '    <label for="lf-contact">Phone or email</label>' +
    '    <input id="lf-contact" name="contact" type="text" autocomplete="email" required>' +
    '    <label for="lf-need">What do you need?</label>' +
    '    <textarea id="lf-need" name="need"></textarea>' +
    '    <button class="send" type="submit">Send</button>' +
    '    <div class="note" role="status"></div>' +
    '    <div class="err" role="alert"></div>' +
    "  </form>" +
    '  <form class="composer">' +
    '    <input type="text" aria-label="Type your message" placeholder="Type your message&hellip;" maxlength="1000" autocomplete="off">' +
    '    <button type="submit">Send</button>' +
    "  </form>" +
    "</section>";
  root.appendChild(wrap);
  document.body.appendChild(host);

  // ---- Element handles ---------------------------------------------------
  var bubble = root.querySelector(".bubble");
  var panel = root.querySelector(".panel");
  var closeBtn = root.querySelector(".close");
  var messagesEl = root.querySelector(".messages");
  var typingEl = root.querySelector(".typing");
  var composer = root.querySelector(".composer");
  var input = composer.querySelector("input");
  var sendBtn = composer.querySelector("button");
  var leadOpenBtn = root.querySelector(".leadopen");
  var leadForm = root.querySelector(".leadform");
  var leadNote = leadForm.querySelector(".note");
  var leadErr = leadForm.querySelector(".err");

  // ---- State -------------------------------------------------------------
  var history = []; // [{role: "user"|"assistant", content: "..."}]
  var greeted = false;
  var busy = false;

  // ---- Helpers -----------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }
  function addMessage(role, text) {
    var div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "bot");
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function setBusy(on) {
    busy = on;
    typingEl.style.display = on ? "block" : "none";
    input.disabled = on;
    sendBtn.disabled = on;
    if (on) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function postJson(path, payload) {
    return fetch(ENDPOINT + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  // ---- Open / close ------------------------------------------------------
  function openPanel() {
    panel.classList.add("open");
    if (!greeted) {
      greeted = true;
      addMessage("assistant", GREETING);
      history.push({ role: "assistant", content: GREETING });
    }
    setTimeout(function () { input.focus(); }, 50);
  }
  function closePanel() {
    panel.classList.remove("open");
    bubble.focus();
  }
  bubble.addEventListener("click", function () {
    panel.classList.contains("open") ? closePanel() : openPanel();
  });
  closeBtn.addEventListener("click", closePanel);

  // ---- Chat send ---------------------------------------------------------
  composer.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    addMessage("user", text);
    history.push({ role: "user", content: text });
    setBusy(true);

    postJson("/chat", { site: SITE, messages: history.slice(-12) })
      .then(function (data) {
        var reply = (data && data.reply) || "Sorry — I didn't catch that. Could you try again?";
        addMessage("assistant", reply);
        history.push({ role: "assistant", content: reply });
      })
      .catch(function () {
        addMessage(
          "assistant",
          "Sorry — something went wrong on my end. Please try again in a moment, or use the “Leave your number” button and we'll reach out."
        );
      })
      .then(function () { setBusy(false); input.focus(); });
  });

  // ---- Lead form ---------------------------------------------------------
  leadOpenBtn.addEventListener("click", function () {
    leadForm.classList.toggle("open");
    if (leadForm.classList.contains("open")) {
      leadForm.querySelector("#lf-name").focus();
    }
  });

  leadForm.addEventListener("submit", function (e) {
    e.preventDefault();
    leadNote.style.display = "none";
    leadErr.style.display = "none";

    var name = leadForm.querySelector("#lf-name").value.trim();
    var contact = leadForm.querySelector("#lf-contact").value.trim();
    var need = leadForm.querySelector("#lf-need").value.trim();

    if (!name || !contact) {
      leadErr.textContent = "Please add your name and a phone number or email.";
      leadErr.style.display = "block";
      return;
    }

    var send = leadForm.querySelector(".send");
    send.disabled = true;
    send.textContent = "Sending…";

    postJson("/lead", { site: SITE, name: name, contact: contact, need: need })
      .then(function () {
        leadForm.reset();
        leadNote.textContent = "Thanks, " + name.split(" ")[0] + " — we've got it and will reach out soon.";
        leadNote.style.display = "block";
        addMessage("assistant", "Thanks! Your details are in — someone will reach out soon. Anything else I can answer in the meantime?");
      })
      .catch(function () {
        leadErr.textContent = "That didn't go through — please try again, or email us directly.";
        leadErr.style.display = "block";
      })
      .then(function () {
        send.disabled = false;
        send.textContent = "Send";
      });
  });
})();
