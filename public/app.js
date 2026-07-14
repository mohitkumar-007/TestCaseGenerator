/* ==========================================================================
   Test Case Generator — app.js
   Vanilla JS, no build step. Reads configuration from window.CONFIG
   (see config.example.js — copy to config.js and fill in your values).
   ========================================================================== */

(function () {
  "use strict";

  // ---- Config guard -------------------------------------------------------
  // config.js is gitignored; if it's missing, CONFIG won't exist.
  if (typeof CONFIG === "undefined") {
    document.getElementById("chat-messages").innerHTML =
      '<p class="config-error">Missing config.js — copy config.example.js to ' +
      "config.js and fill in BASE_URL / FLOW_ID / API_KEY.</p>";
    return;
  }

  // ---- DOM refs -------------------------------------------------------
  const elements = {
    chatPanel: document.getElementById("chat-panel"),
    chatMessages: document.getElementById("chat-messages"),
    composer: document.getElementById("composer"),
    chatInput: document.getElementById("chat-input"),
    sendBtn: document.getElementById("send-btn"),
    attachBtn: document.getElementById("attach-btn"),
    fileInput: document.getElementById("file-input"),
    fileChipRow: document.getElementById("file-chip-row"),
    statusBar: document.getElementById("status-bar"),
    sidebarSearch: document.getElementById("sidebar-search"),
    jiraBtn: document.getElementById("jira-btn"),
    jiraPanel: document.getElementById("jira-panel"),
    jiraFetchView: document.getElementById("jira-fetch-view"),
    jiraImportedView: document.getElementById("jira-imported-view"),
    jiraIdInput: document.getElementById("jira-id-input"),
    jiraFetchBtn: document.getElementById("jira-fetch-btn"),
    jiraTicketLabel: document.getElementById("jira-ticket-label"),
    jiraSummary: document.getElementById("jira-summary"),
    jiraDescription: document.getElementById("jira-description"),
    jiraAcceptance: document.getElementById("jira-acceptance"),
    jiraGenerateBtn: document.getElementById("jira-generate-btn"),
  };

  // ---- Session state -------------------------------------------------------
  const state = {
    sessionId: crypto.randomUUID(),
    attachedFile: null,
    lastRequest: null,
    abortController: null,
    jiraTicket: null,
  };

  // Single constant so renaming the assistant later is a one-line change.
  const ASSISTANT_NAME = "TestPilot";
  const WELCOME_MESSAGE = "Happy to help you in Testcase generation";

  // ==========================================================================
  // Section: Conversation history registry (localStorage)
  // Tracks past conversations for the sidebar: { id, title, createdAt, lastUsedAt }.
  // Message content itself is NOT stored here — it lives in Langflow and is
  // fetched on demand via the monitor API. This registry only remembers which
  // sessions exist and their display metadata.
  // ==========================================================================

  const SESSION_REGISTRY_KEY = "tcgen_sessions";

  function loadSessionRegistry() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SESSION_REGISTRY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveSessionRegistry(sessions) {
    localStorage.setItem(SESSION_REGISTRY_KEY, JSON.stringify(sessions));
  }

  function truncateTitle(text, maxLen) {
    const trimmed = (text || "").trim().replace(/\s+/g, " ");
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen).trim() + "…" : trimmed;
  }

  // Used by "+ New Chat": registers the session up front, before any message
  // has been sent, so it shows up in the sidebar immediately.
  function createSessionEntry(id) {
    const now = new Date().toISOString();
    const sessions = loadSessionRegistry();
    sessions.unshift({ id: id, title: "New Chat", createdAt: now, lastUsedAt: now });
    saveSessionRegistry(sessions);
  }

  // Called on every sent message: bumps lastUsedAt, and sets the title the
  // first time only (from the message text or attached filename). Also
  // covers the page-load default session, which starts life unregistered
  // until its first message.
  function touchSession(id, titleCandidate) {
    const sessions = loadSessionRegistry();
    const now = new Date().toISOString();
    let entry = sessions.find(function (s) { return s.id === id; });
    if (!entry) {
      entry = { id: id, title: truncateTitle(titleCandidate, 40), createdAt: now, lastUsedAt: now };
      sessions.unshift(entry);
    } else {
      if (!entry.title || entry.title === "New Chat") {
        entry.title = truncateTitle(titleCandidate, 40);
      }
      entry.lastUsedAt = now;
    }
    saveSessionRegistry(sessions);
  }

  function removeSessionEntry(id) {
    saveSessionRegistry(loadSessionRegistry().filter(function (s) { return s.id !== id; }));
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function daysSince(isoString, now) {
    return Math.round((startOfDay(now) - startOfDay(isoString)) / 86400000);
  }

  // Buckets sessions into the sidebar's date groups, most-recent-first within
  // each group. Groups with no sessions are omitted entirely.
  function groupSessionsByRecency(sessions, now) {
    now = now || new Date();
    const buckets = [
      { label: "Today", items: [] },
      { label: "Yesterday", items: [] },
      { label: "Previous 7 Days", items: [] },
      { label: "Previous 30 Days", items: [] },
      { label: "Over 30 days", items: [] },
    ];
    sessions.forEach(function (s) {
      const diff = daysSince(s.lastUsedAt, now);
      if (diff <= 0) buckets[0].items.push(s);
      else if (diff === 1) buckets[1].items.push(s);
      else if (diff <= 7) buckets[2].items.push(s);
      else if (diff <= 30) buckets[3].items.push(s);
      else buckets[4].items.push(s);
    });
    buckets.forEach(function (b) {
      b.items.sort(function (a, c) { return new Date(c.lastUsedAt) - new Date(a.lastUsedAt); });
    });
    return buckets.filter(function (b) { return b.items.length > 0; });
  }

  // ==========================================================================
  // Section: Langflow API layer
  // ==========================================================================

  /**
   * POSTs to the Langflow /run endpoint shared by both text and file mode.
   * Throws an Error with .isNetworkError set for fetch/CORS failures, or
   * .status set for non-2xx HTTP responses, so the UI layer can branch on it.
   * Accepts an optional AbortSignal for cancellation.
   */
  async function callLangflowRun(payload, signal) {
    let res;
    try {
      res = await fetch(CONFIG.BASE_URL + "/api/v1/run/" + CONFIG.FLOW_ID, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CONFIG.API_KEY,
        },
        body: JSON.stringify(payload),
        signal: signal,
      });
    } catch (e) {
      // AbortError is thrown when signal.abort() is called — this is a user-
      // initiated cancellation, not a network failure.
      if (e.name === "AbortError") {
        const err = new Error("Generation stopped.");
        err.isAborted = true;
        throw err;
      }
      throw networkError();
    }

    if (!res.ok) {
      throw await httpError("Langflow run failed", res);
    }
    return res.json();
  }

  // Builds the common run-request body: chat in/out, session continuity,
  // and any per-call tweaks merged with the user's global MODEL_TWEAKS.
  function buildRunPayload(inputValue, extraTweaks) {
    return {
      output_type: "chat",
      input_type: "chat",
      input_value: inputValue,
      session_id: state.sessionId,
      tweaks: Object.assign({}, extraTweaks, CONFIG.MODEL_TWEAKS),
    };
  }

  // Text mode: just send the user's story straight through.
  async function runTextGeneration(userStoryText, signal) {
    return callLangflowRun(buildRunPayload(userStoryText, {}), signal);
  }

  // File mode step 2: run the flow, pointing its File component at the
  // path returned by uploadFile(). Resolves the File component ID automatically
  // from the flow definition if not explicitly set in config.js.
  async function runFileGeneration(uploadedPath, filename, signal) {
    const fileComponentId = await resolveFileComponentId();
    const extraTweaks = {};
    extraTweaks[fileComponentId] = { path: uploadedPath };
    const inputValue = "Generate test cases from the attached PRD: " + filename;
    return callLangflowRun(buildRunPayload(inputValue, extraTweaks), signal);
  }

  // Cached File component ID — avoids re-fetching the flow definition on every upload.
  let _resolvedFileComponentId = CONFIG.FILE_COMPONENT_ID || null;

  async function resolveFileComponentId() {
    if (_resolvedFileComponentId) return _resolvedFileComponentId;
    _resolvedFileComponentId = await resolveComponentId(
      /\bfile\b/i,
      /^file-/i,
      "Could not find a File component in the Langflow flow. " +
      "Add a File component to your flow or set FILE_COMPONENT_ID in config.js."
    );
    return _resolvedFileComponentId;
  }

  // Jira mode: run the flow, feeding the imported ticket's Summary/Description/
  // Acceptance Criteria into the flow's JiraFetchOrPassthrough component via
  // its `prefetched_story` input (same tweaks pattern as File mode) instead
  // of the chat input_value — the chat message stays a short one-liner, the
  // full story is a tweak. That component returns `prefetched_story`
  // verbatim when it's non-empty, skipping its own Jira-fetch logic.
  async function runJiraStoryGeneration(jiraStoryText, ticketId, signal) {
    const storyComponentId = await resolvePrefetchedStoryComponentId();
    const extraTweaks = {};
    extraTweaks[storyComponentId] = { prefetched_story: jiraStoryText };
    const inputValue = "Generate test cases from imported Jira ticket " + ticketId;
    return callLangflowRun(buildRunPayload(inputValue, extraTweaks), signal);
  }

  // Cached prefetched-story component ID — avoids re-fetching the flow
  // definition on every Generate click.
  let _resolvedPrefetchedStoryComponentId = CONFIG.PREFETCHED_STORY_COMPONENT_ID || null;

  async function resolvePrefetchedStoryComponentId() {
    if (_resolvedPrefetchedStoryComponentId) return _resolvedPrefetchedStoryComponentId;
    _resolvedPrefetchedStoryComponentId = await resolveComponentId(
      /prefetched.?story|jira.*(fetch|passthrough)/i,
      /^(prefetched.?story)-/i,
      "Could not find the JiraFetchOrPassthrough component in the Langflow flow. " +
      "Add one (with a `prefetched_story` input) or set PREFETCHED_STORY_COMPONENT_ID in config.js."
    );
    return _resolvedPrefetchedStoryComponentId;
  }

  // Shared flow-definition lookup used to auto-discover a component ID by
  // node type/id pattern when it isn't explicitly pinned in config.js.
  async function resolveComponentId(typePattern, idPattern, notFoundMessage) {
    let res;
    try {
      res = await fetch(CONFIG.BASE_URL + "/api/v1/flows/" + CONFIG.FLOW_ID, {
        headers: { "x-api-key": CONFIG.API_KEY },
      });
    } catch (e) {
      throw networkError();
    }
    if (!res.ok) throw await httpError("Could not fetch flow definition", res);

    const flow = await res.json();
    const nodes =
      (flow.data && flow.data.nodes) ||
      flow.nodes ||
      [];

    const node = nodes.find(function (node) {
      const type =
        (node.data && node.data.type) ||
        node.type ||
        node.id ||
        "";
      return typePattern.test(type) || idPattern.test(node.id || "");
    });

    if (!node) throw new Error(notFoundMessage);
    return node.id;
  }

  // File mode step 1: upload the PDF and return the server-side path Langflow
  // expects in tweaks. Tries the modern /api/v2/files endpoint first, and
  // falls back to the legacy per-flow upload route on 404 (older Langflow).
  async function uploadFile(file) {
    const formData = new FormData();
    formData.append("file", file);

    let res;
    try {
      res = await fetch(CONFIG.BASE_URL + "/api/v2/files", {
        method: "POST",
        headers: { "x-api-key": CONFIG.API_KEY },
        body: formData,
      });
    } catch (e) {
      throw networkError();
    }

    if (res.status === 404) {
      return uploadFileLegacy(file);
    }
    if (!res.ok) {
      throw await httpError("File upload failed", res);
    }
    return extractUploadedPath(await res.json());
  }

  async function uploadFileLegacy(file) {
    const formData = new FormData();
    formData.append("file", file);

    let res;
    try {
      res = await fetch(
        CONFIG.BASE_URL + "/api/v1/files/upload/" + CONFIG.FLOW_ID,
        { method: "POST", headers: { "x-api-key": CONFIG.API_KEY }, body: formData }
      );
    } catch (e) {
      throw networkError();
    }

    if (!res.ok) {
      throw await httpError("File upload failed", res);
    }
    return extractUploadedPath(await res.json());
  }

  // Different Langflow versions key the uploaded path differently
  // (path / file_path / filePath) — check all of them defensively.
  function extractUploadedPath(data) {
    const path = data.path || data.file_path || data.filePath;
    if (!path) {
      const err = new Error("Could not determine uploaded file path from Langflow's response.");
      err.detail = JSON.stringify(data);
      throw err;
    }
    return path;
  }

  // Defensively pulls the assistant's reply text out of the run response.
  // Langflow's output shape can vary by flow/version, so we try progressively
  // looser fallbacks rather than letting a shape change crash the UI.
  function extractMessageText(data) {
    try {
      const text = data.outputs[0].outputs[0].results.message.text;
      if (typeof text === "string") return text;
    } catch (e) {
      /* fall through to next strategy */
    }
    try {
      const artifact = data.outputs[0].outputs[0].artifacts.message;
      if (typeof artifact === "string") return artifact;
    } catch (e) {
      /* fall through to next strategy */
    }
    try {
      return "```json\n" + JSON.stringify(data, null, 2) + "\n```";
    } catch (e) {
      return "Received a response but could not parse it.";
    }
  }

  function networkError() {
    const err = new Error(
      "Could not reach Langflow at " + CONFIG.BASE_URL +
      ". Check that Langflow is running and CORS/serving setup " +
      "(serve this page via http://, not file://)."
    );
    err.isNetworkError = true;
    return err;
  }

  async function httpError(label, res) {
    const err = new Error(label + " (HTTP " + res.status + ")");
    err.status = res.status;
    err.detail = await res.text().catch(() => "");
    return err;
  }

  // ==========================================================================
  // Section: Chat rendering (bubbles, markdown/table parser, typing indicator)
  // ==========================================================================

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function nowTimeString() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function scrollToBottom() {
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }

  // ---- Minimal Markdown renderer -------------------------------------------
  // Supports the subset test-case output actually uses: headers, bold/italic,
  // inline code, fenced code blocks, lists, paragraphs, and — the one that
  // matters most here — pipe tables rendered as real <table> markup.

  function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
    return out;
  }

  function splitTableRow(line) {
    let trimmed = line.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map(function (c) { return c.trim(); });
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
  }

  function renderTable(tableLines) {
    const headerCells = splitTableRow(tableLines[0]);
    const bodyRows = tableLines.slice(2).map(splitTableRow);
    let html = '<table class="md-table"><thead><tr>';
    headerCells.forEach(function (c) {
      html += "<th>" + renderInline(c) + "</th>";
    });
    html += "</tr></thead><tbody>";
    bodyRows.forEach(function (row) {
      html += "<tr>";
      row.forEach(function (c) {
        html += "<td>" + renderInline(c) + "</td>";
      });
      html += "</tr>";
    });
    html += "</tbody></table>";
    return html;
  }

  function isBlockStart(line) {
    return (
      /^```/.test(line) ||
      /^\s*\|.*\|\s*$/.test(line) ||
      /^(#{1,6})\s+/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line)
    );
  }

  function renderMarkdown(md) {
    const lines = String(md).replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (/^```/.test(line)) {
        i++;
        const codeLines = [];
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i++;
        }
        i++; // skip closing fence
        html += "<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>";
        continue;
      }

      // Pipe table: a "| a | b |" row followed by a "|---|---|" separator
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const tableLines = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          tableLines.push(lines[i]);
          i++;
        }
        html += renderTable(tableLines);
        continue;
      }

      // Headers
      const headerMatch = /^(#{1,6})\s+(.*)$/.exec(line);
      if (headerMatch) {
        const level = headerMatch[1].length;
        html += "<h" + level + ">" + renderInline(headerMatch[2]) + "</h" + level + ">";
        i++;
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i++;
        }
        html += "<ul>" + items.map(function (it) { return "<li>" + renderInline(it) + "</li>"; }).join("") + "</ul>";
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i++;
        }
        html += "<ol>" + items.map(function (it) { return "<li>" + renderInline(it) + "</li>"; }).join("") + "</ol>";
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }

      // Paragraph: everything up to the next blank line or block start
      const paraLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      html += "<p>" + renderInline(paraLines.join(" ")) + "</p>";
    }

    return html;
  }

  // ---- Message bubbles -------------------------------------------------------

  function appendUserMessage(text) {
    clearEmptyState();
    const el = document.createElement("div");
    el.className = "message message-user";
    el.dataset.messageText = text;
    el.innerHTML =
      '<div class="message-bubble">' + escapeHtml(text).replace(/\n/g, "<br>") + "</div>" +
      '<div class="message-meta">' + nowTimeString() + "</div>";

    // Edit button: inline editing with Save/Cancel
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "msg-edit-btn";
    editBtn.setAttribute("aria-label", "Edit message");
    editBtn.title = "Edit message";
    editBtn.innerHTML = "&#9998;"; // ✎ pencil icon
    editBtn.addEventListener("click", function () {
      onEditUserMessage(el);
    });
    el.appendChild(editBtn);

    elements.chatMessages.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendAssistantMessage(markdownText) {
    const el = document.createElement("div");
    el.className = "message message-assistant";
    el.dataset.rawMarkdown = markdownText;
    el.innerHTML =
      '<div class="message-bubble">' + renderMarkdown(markdownText) + "</div>" +
      '<div class="message-meta">' + ASSISTANT_NAME + " · " + nowTimeString() + "</div>";

    // Per-message copy button — copies raw markdown (spec item 9)
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-copy-btn";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.title = "Copy message";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(markdownText).then(function () {
        copyBtn.textContent = "Copied!";
        setTimeout(function () { copyBtn.textContent = "Copy"; }, 1500);
      });
    });
    el.appendChild(copyBtn);

    elements.chatMessages.appendChild(el);
    scrollToBottom();

    // Enable export / copy-all if this response contains a markdown table
    if (/\|.*\|/.test(markdownText)) setExportState(true);

    return el;
  }

  function showTypingIndicator() {
    const el = document.createElement("div");
    el.className = "message message-assistant message-typing";
    el.id = "typing-indicator";
    el.innerHTML =
      '<div class="message-bubble typing-dots"><span></span><span></span><span></span></div>' +
      '<button type="button" class="stop-btn" id="stop-btn" aria-label="Stop generating" title="Stop generating">&#9209;</button>';
    elements.chatMessages.appendChild(el);
    scrollToBottom();

    // Wire stop button
    const stopBtn = document.getElementById("stop-btn");
    if (stopBtn) {
      stopBtn.addEventListener("click", function () {
        if (state.abortController) {
          state.abortController.abort();
        }
      });
    }
  }

  function hideTypingIndicator() {
    const el = document.getElementById("typing-indicator");
    if (el) el.remove();
  }

  function appendErrorMessage(err, retryFn) {
    const el = document.createElement("div");
    el.className = "message message-error";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble error-bubble";
    bubble.textContent = err.message;
    if (err.detail) {
      const detail = document.createElement("div");
      detail.className = "error-detail";
      detail.textContent = err.detail;
      bubble.appendChild(detail);
    }

    el.appendChild(bubble);

    if (retryFn) {
      const retryBtn = document.createElement("button");
      retryBtn.type = "button";
      retryBtn.className = "retry-btn";
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", function () {
        el.remove();
        retryFn();
      });
      el.appendChild(retryBtn);
    }

    elements.chatMessages.appendChild(el);
    scrollToBottom();
  }

  // ---- Send flow -------------------------------------------------------

  function onEditUserMessage(messageEl) {
    const originalText = messageEl.dataset.messageText;
    if (!originalText) return;

    // Already editing? Ignore.
    if (messageEl.classList.contains("message-editing")) return;

    const bubble = messageEl.querySelector(".message-bubble");
    if (!bubble) return;

    // Switch to edit mode
    messageEl.classList.add("message-editing");

    // Replace bubble with textarea
    const textarea = document.createElement("textarea");
    textarea.className = "message-edit-textarea";
    textarea.value = originalText;
    textarea.rows = Math.min(10, originalText.split("\n").length + 1);
    bubble.replaceWith(textarea);
    textarea.focus();
    textarea.select();

    // Hide Edit button (CSS handles this via .message-editing class)
    const editBtn = messageEl.querySelector(".msg-edit-btn");

    const actionsRow = document.createElement("div");
    actionsRow.className = "message-edit-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "msg-edit-save-btn";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", function () {
      const newText = textarea.value.trim();
      if (newText) {
        messageEl.dataset.messageText = newText;
        const newBubble = document.createElement("div");
        newBubble.className = "message-bubble";
        newBubble.innerHTML = escapeHtml(newText).replace(/\n/g, "<br>");
        textarea.replaceWith(newBubble);
        messageEl.classList.remove("message-editing");
        actionsRow.remove();
      }
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "msg-edit-cancel-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", function () {
      const originalBubble = document.createElement("div");
      originalBubble.className = "message-bubble";
      originalBubble.innerHTML = escapeHtml(originalText).replace(/\n/g, "<br>");
      textarea.replaceWith(originalBubble);
      messageEl.classList.remove("message-editing");
      actionsRow.remove();
    });

    actionsRow.appendChild(saveBtn);
    actionsRow.appendChild(cancelBtn);
    messageEl.appendChild(actionsRow);
  }

  // ---- Send flow -------------------------------------------------------

  function autoResizeInput() {
    const el = elements.chatInput;
    el.style.height = "auto";
    const newHeight = Math.min(el.scrollHeight, 160);
    el.style.height = newHeight + "px";
    el.style.overflowY = el.scrollHeight > 160 ? "auto" : "hidden";
  }

  async function sendUserStory(text) {
    appendUserMessage(text);
    recordSessionMessage(text);
    state.lastRequest = function () { sendUserStory(text); };
    state.abortController = new AbortController();
    showTypingIndicator();
    elements.sendBtn.disabled = true;
    const t0 = Date.now();
    try {
      const data = await runTextGeneration(text, state.abortController.signal);
      hideTypingIndicator();
      appendAssistantMessage(extractMessageText(data));
      updateStatusBar(Date.now() - t0);
    } catch (err) {
      hideTypingIndicator();
      if (!err.isAborted) {
        appendErrorMessage(err, state.lastRequest);
      }
    } finally {
      state.abortController = null;
      elements.sendBtn.disabled = false;
    }
  }

  // File mode send: upload then run, showing "Analyzing <filename>..." as
  // the user-facing message instead of the raw file object.
  async function sendFileStory(file) {
    appendUserMessage("Analyzing " + file.name + "...");
    recordSessionMessage(file.name);
    state.lastRequest = function () { sendFileStory(file); };
    state.abortController = new AbortController();
    showTypingIndicator();
    elements.sendBtn.disabled = true;
    const t0 = Date.now();
    try {
      const uploadedPath = await uploadFile(file);
      const data = await runFileGeneration(uploadedPath, file.name, state.abortController.signal);
      hideTypingIndicator();
      appendAssistantMessage(extractMessageText(data));
      updateStatusBar(Date.now() - t0);
    } catch (err) {
      hideTypingIndicator();
      if (!err.isAborted) {
        appendErrorMessage(err, state.lastRequest);
      }
    } finally {
      state.abortController = null;
      elements.sendBtn.disabled = false;
    }
  }

  // ==========================================================================
  // Section: Jira Connector
  // ==========================================================================

  function showJiraFetchPanel() {
    elements.jiraPanel.hidden = false;
    elements.jiraFetchView.hidden = false;
    elements.jiraImportedView.hidden = true;
    elements.jiraBtn.classList.add("jira-active");
    elements.jiraIdInput.focus();
  }

  function showJiraImportedPanel(ticket) {
    state.jiraTicket = ticket;
    elements.jiraTicketLabel.textContent = ticket.id;
    elements.jiraSummary.value = ticket.summary;
    elements.jiraDescription.value = ticket.description;
    elements.jiraAcceptance.value = ticket.acceptanceCriteria;
    elements.jiraFetchView.hidden = true;
    elements.jiraImportedView.hidden = false;
  }

  function hideJiraPanel() {
    elements.jiraPanel.hidden = true;
    elements.jiraBtn.classList.remove("jira-active");
    state.jiraTicket = null;
  }

  function jiraNetworkError() {
    const err = new Error(
      "Could not reach the Jira proxy. Check that server.js is running " +
      "(npm start) and this page was loaded from it, not from a separate " +
      "static file server."
    );
    err.isNetworkError = true;
    return err;
  }

  // Fetch is same-origin: server.js serves this page AND proxies Jira, so
  // the browser never holds a Jira token and never talks to Jira directly.
  async function fetchJiraTicket() {
    const ticketId = elements.jiraIdInput.value.trim().toUpperCase();
    if (!ticketId) { elements.jiraIdInput.focus(); return; }

    elements.jiraFetchBtn.disabled = true;
    elements.jiraFetchBtn.textContent = "Fetching…";

    try {
      let res;
      try {
        res = await fetch("/api/jira/" + encodeURIComponent(ticketId));
      } catch (e) {
        throw jiraNetworkError();
      }
      if (!res.ok) throw await httpError("Jira fetch failed", res);
      const ticket = await res.json();
      showJiraImportedPanel(ticket);
    } catch (err) {
      appendErrorMessage(err, null);
    } finally {
      elements.jiraFetchBtn.disabled = false;
      elements.jiraFetchBtn.textContent = "Fetch";
    }
  }

  // Jira mode send: compose the jira_story text from the three editable
  // fields and run it through the prefetched-story tweak (see
  // runJiraStoryGeneration) rather than as a freeform chat message — the
  // chat only shows a short "Generate test cases from imported ticket ..."
  // line, same UX as File mode's "Analyzing <filename>...".
  function sendJiraStory() {
    if (!state.jiraTicket) return;
    const ticketId = state.jiraTicket.id;
    const summary = elements.jiraSummary.value.trim();
    const description = elements.jiraDescription.value.trim();
    const acceptance = elements.jiraAcceptance.value.trim();
    const jiraStoryText =
      ticketId + "\n\n" +
      "Summary: " + summary + "\n\n" +
      "Description: " + description + "\n\n" +
      "Acceptance Criteria:\n" + acceptance;
    hideJiraPanel();
    runJiraStorySend(jiraStoryText, ticketId);
  }

  async function runJiraStorySend(jiraStoryText, ticketId) {
    appendUserMessage("Generate test cases from imported ticket " + ticketId + "...");
    recordSessionMessage(ticketId);
    state.lastRequest = function () { runJiraStorySend(jiraStoryText, ticketId); };
    state.abortController = new AbortController();
    showTypingIndicator();
    elements.sendBtn.disabled = true;
    const t0 = Date.now();
    try {
      const data = await runJiraStoryGeneration(jiraStoryText, ticketId, state.abortController.signal);
      hideTypingIndicator();
      appendAssistantMessage(extractMessageText(data));
      updateStatusBar(Date.now() - t0);
    } catch (err) {
      hideTypingIndicator();
      if (!err.isAborted) {
        appendErrorMessage(err, state.lastRequest);
      }
    } finally {
      state.abortController = null;
      elements.sendBtn.disabled = false;
    }
  }

  elements.composer.addEventListener("submit", function (evt) {
    evt.preventDefault();
    const text = elements.chatInput.value.trim();
    const file = state.attachedFile;

    if (file) {
      clearAttachedFile();
      elements.chatInput.value = "";
      autoResizeInput();
      sendFileStory(file);
      return;
    }

    if (!text) return;
    elements.chatInput.value = "";
    autoResizeInput();
    sendUserStory(text);
  });

  elements.chatInput.addEventListener("keydown", function (evt) {
    if (evt.key === "Enter" && !evt.shiftKey) {
      evt.preventDefault();
      elements.composer.requestSubmit();
    }
  });

  elements.chatInput.addEventListener("input", autoResizeInput);

  // ==========================================================================
  // Section: File attach (paperclip, drag-and-drop, chip)
  // ==========================================================================

  function isAcceptedFile(file) {
    return /\.pdf$/i.test(file.name);
  }

  function setAttachedFile(file) {
    if (!file) return;
    if (!isAcceptedFile(file)) {
      appendErrorMessage(new Error("Only PDF files are supported."), null);
      return;
    }
    state.attachedFile = file;
    renderFileChip();
  }

  function clearAttachedFile() {
    state.attachedFile = null;
    elements.fileInput.value = "";
    renderFileChip();
  }

  function renderFileChip() {
    elements.fileChipRow.innerHTML = "";
    if (!state.attachedFile) return;

    const chip = document.createElement("div");
    chip.className = "file-chip";

    const label = document.createElement("span");
    label.className = "file-chip-name";
    label.textContent = "📄 " + state.attachedFile.name;
    chip.appendChild(label);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "file-chip-remove";
    removeBtn.setAttribute("aria-label", "Remove attached file");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", clearAttachedFile);
    chip.appendChild(removeBtn);

    elements.fileChipRow.appendChild(chip);
  }

  elements.attachBtn.addEventListener("click", function () {
    elements.fileInput.click();
  });

  elements.fileInput.addEventListener("change", function () {
    setAttachedFile(elements.fileInput.files[0]);
  });

  // Drag-and-drop onto the whole chat area (messages + composer), not just
  // the input, per spec.
  ["dragenter", "dragover"].forEach(function (evtName) {
    elements.chatPanel.addEventListener(evtName, function (evt) {
      evt.preventDefault();
      elements.chatPanel.classList.add("drag-over");
    });
  });

  elements.chatPanel.addEventListener("dragleave", function (evt) {
    if (evt.target === elements.chatPanel) {
      elements.chatPanel.classList.remove("drag-over");
    }
  });

  elements.chatPanel.addEventListener("drop", function (evt) {
    evt.preventDefault();
    elements.chatPanel.classList.remove("drag-over");
    const file = evt.dataTransfer.files && evt.dataTransfer.files[0];
    setAttachedFile(file);
  });

  // ==========================================================================
  // Section: Sample story cards + empty state
  // ==========================================================================

  const SAMPLE_STORIES = [
    {
      domain: "Banking",
      icon: "🏦",
      title: "Fund Transfer",
      text:
        "As a bank customer, I want to transfer funds between my linked " +
        "accounts so that I can move money without visiting a branch. The " +
        "transfer should validate available balance, daily limits, and " +
        "require OTP confirmation before completing.",
    },
    {
      domain: "Insurance",
      icon: "🛡️",
      title: "Policy Claim Submission",
      text:
        "As a policyholder, I want to submit a claim for a covered incident " +
        "with supporting documents so that my claim can be reviewed and " +
        "processed. The system should validate policy status, required " +
        "documents, and claim deadlines before accepting the submission.",
    },
    {
      domain: "Finance",
      icon: "📊",
      title: "Loan EMI Calculation",
      text:
        "As a loan applicant, I want to calculate my monthly EMI based on " +
        "loan amount, interest rate, and tenure so that I can evaluate " +
        "affordability before applying. The calculator should handle edge " +
        "cases like zero interest and validate input ranges.",
    },
  ];

  // Renders the centered welcome + sample-story cards shown before the
  // first message. Cards fill the input on click; they don't auto-send,
  // so the user can edit the story first.
  function renderEmptyState() {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.id = "empty-state";

    const cardsHtml = SAMPLE_STORIES.map(function (story, idx) {
      return (
        '<button type="button" class="sample-card" data-story-index="' + idx + '">' +
          '<span class="sample-card-icon" aria-hidden="true">' + story.icon + "</span>" +
          '<span class="sample-card-domain">' + escapeHtml(story.domain) + "</span>" +
          '<span class="sample-card-title">' + escapeHtml(story.title) + "</span>" +
        "</button>"
      );
    }).join("");

    el.innerHTML =
      '<div class="empty-state-inner">' +
        '<div class="empty-state-badge" aria-hidden="true">💬</div>' +
        '<h2 class="empty-state-title">' + escapeHtml(ASSISTANT_NAME) + "</h2>" +
        '<p class="empty-state-message">' + escapeHtml(WELCOME_MESSAGE) + "</p>" +
        '<p class="empty-state-hint">Try a sample story, or type your own below.</p>' +
        '<div class="sample-cards">' + cardsHtml + "</div>" +
      "</div>";

    elements.chatMessages.appendChild(el);

    el.querySelectorAll(".sample-card").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const story = SAMPLE_STORIES[Number(btn.dataset.storyIndex)];
        elements.chatInput.value = story.text;
        autoResizeInput();
        elements.chatInput.focus();
      });
    });
  }

  function clearEmptyState() {
    const el = document.getElementById("empty-state");
    if (el) el.remove();
  }

  // ==========================================================================
  // Section: Model selector
  // Populates the dropdown, persists the user's choice in localStorage, and
  // pipes the selected name into CONFIG.MODEL_TWEAKS so every subsequent
  // /run call uses it.
  // ==========================================================================

  const MODEL_STORAGE_KEY = "tcgen_selected_model";

  const MODEL_LIST = [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-preview-09-2025",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-2.5-flash-image",
    "gemini-1.5-pro",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-preview-image-generation",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
  ];

  // The tweaks key of the Gemini component in the current flow (e.g.
  // "GoogleGenerativeAIModel" or "GoogleGenerativeAIModel-AbC12"). We
  // reuse whatever key the user already put in config.js so this works
  // whether they used a bare component name or a suffixed instance ID.
  function getModelComponentKey() {
    const keys = Object.keys(CONFIG.MODEL_TWEAKS || {});
    return keys[0] || "GoogleGenerativeAIModel";
  }

  function getCurrentModel() {
    const key = getModelComponentKey();
    const tweak = CONFIG.MODEL_TWEAKS && CONFIG.MODEL_TWEAKS[key];
    return (tweak && tweak.model_name) || MODEL_LIST[0];
  }

  // Mutates CONFIG.MODEL_TWEAKS in place — `const CONFIG` prevents
  // reassignment but not property mutation. Every subsequent buildRunPayload
  // call will pick up the new value.
  function setCurrentModel(modelName) {
    const key = getModelComponentKey();
    if (!CONFIG.MODEL_TWEAKS) CONFIG.MODEL_TWEAKS = {};
    if (!CONFIG.MODEL_TWEAKS[key]) CONFIG.MODEL_TWEAKS[key] = {};
    CONFIG.MODEL_TWEAKS[key].model_name = modelName;
    localStorage.setItem(MODEL_STORAGE_KEY, modelName);
    renderModelButton();
    updateStatusBar(null);
  }

  function renderModelButton() {
    const nameEl = document.getElementById("model-name");
    if (nameEl) nameEl.textContent = getCurrentModel();
  }

  function renderModelDropdown() {
    const dropdown = document.getElementById("model-dropdown");
    if (!dropdown) return;
    const current = getCurrentModel();
    dropdown.innerHTML = MODEL_LIST.map(function (name) {
      const active = name === current ? " model-option-active" : "";
      const check = name === current ? "&#10003;" : "";
      return (
        '<button type="button" class="model-option' + active + '" ' +
        'data-model="' + escapeHtml(name) + '" role="option">' +
        '<span class="model-option-check" aria-hidden="true">' + check + "</span>" +
        '<span class="model-option-name">' + escapeHtml(name) + "</span>" +
        "</button>"
      );
    }).join("");

    dropdown.querySelectorAll(".model-option").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setCurrentModel(btn.dataset.model);
        toggleModelDropdown(false);
      });
    });
  }

  function toggleModelDropdown(forceState) {
    const dropdown = document.getElementById("model-dropdown");
    const btn = document.getElementById("model-btn");
    if (!dropdown || !btn) return;
    const shouldOpen = typeof forceState === "boolean" ? forceState : dropdown.hasAttribute("hidden");
    if (shouldOpen) {
      renderModelDropdown();
      dropdown.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
    } else {
      dropdown.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
    }
  }

  function initModelSelector() {
    // Restore saved model choice on load (falls back to whatever's already
    // in CONFIG.MODEL_TWEAKS from config.js).
    const saved = localStorage.getItem(MODEL_STORAGE_KEY);
    if (saved && MODEL_LIST.indexOf(saved) !== -1) {
      setCurrentModel(saved);
    } else {
      renderModelButton();
    }

    const modelBtn = document.getElementById("model-btn");
    if (modelBtn) {
      modelBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleModelDropdown();
      });
    }

    // Click outside closes the dropdown.
    document.addEventListener("click", function (e) {
      const dropdown = document.getElementById("model-dropdown");
      if (!dropdown || dropdown.hasAttribute("hidden")) return;
      if (!e.target.closest(".model-selector")) toggleModelDropdown(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") toggleModelDropdown(false);
    });
  }

  // ==========================================================================
  // Section: Theme toggle
  // ==========================================================================

  const THEME_KEY = "tcgen-theme";

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("btn-theme");
    if (btn) btn.textContent = theme === "dark" ? "☀" : "☾";
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const preferred =
      saved ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    applyTheme(preferred);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  document.getElementById("btn-theme").addEventListener("click", toggleTheme);

  // ==========================================================================
  // Section: Toolbar actions (clear / copy / export)
  // ==========================================================================

  let hasTable = false;

  function setExportState(enabled) {
    hasTable = enabled;
    const exportBtn = document.getElementById("btn-export");
    const copyAllBtn = document.getElementById("btn-copy-all");
    if (exportBtn) exportBtn.disabled = !enabled;
    if (copyAllBtn) copyAllBtn.disabled = !enabled;
  }

  // Clear chat — resets everything and regenerates the empty state.
  document.getElementById("btn-clear").addEventListener("click", function () {
    if (!confirm("Clear the chat? This will reset the session.")) return;
    elements.chatMessages.innerHTML = "";
    state.sessionId = crypto.randomUUID();
    state.lastRequest = null;
    clearAttachedFile();
    setExportState(false);
    updateStatusBar(null);
    renderEmptyState();
    renderSidebar(); // clear active highlight
  });

  // Copy all test cases (concatenates raw markdown from every assistant message).
  document.getElementById("btn-copy-all").addEventListener("click", function () {
    const messages = elements.chatMessages.querySelectorAll(".message-assistant[data-raw-markdown]");
    const allMarkdown = Array.from(messages)
      .map(function (el) { return el.dataset.rawMarkdown; })
      .join("\n\n---\n\n");
    navigator.clipboard.writeText(allMarkdown).then(function () {
      showToast("Copied to clipboard.");
    });
  });

  // Export to Excel via SheetJS.
  // Parses the LAST assistant message's markdown table(s), maps columns by
  // header name (not position) so column-order changes don't break export.
  document.getElementById("btn-export").addEventListener("click", function () {
    const messages = elements.chatMessages.querySelectorAll(".message-assistant[data-raw-markdown]");
    if (!messages.length) {
      showToast("No test case table found to export.", true);
      return;
    }
    const lastMarkdown = messages[messages.length - 1].dataset.rawMarkdown;
    const rows = extractTableRows(lastMarkdown);
    if (!rows.length) {
      showToast("No test case table found to export.", true);
      return;
    }
    exportRowsToExcel(rows);
  });

  // Maps source columns to the required output columns by header name.
  // Output columns: TC ID | Description | Steps | Priority | Expected Result
  const EXPORT_COLUMNS = ["TC ID", "Description", "Steps", "Priority", "Expected Result"];

  // Model output doesn't always use these exact header names (e.g. "Test Case ID"
  // instead of "TC ID"). Listed in priority order per target column.
  const COLUMN_ALIASES = {
    "TC ID": ["tc id", "test case id", "test id", "id"],
    "Description": ["description", "summary", "title"],
    "Steps": ["steps", "test steps", "steps to reproduce"],
    "Priority": ["priority"],
    "Expected Result": ["expected result", "expected results", "expected output"]
  };

  // Responses often include non-test-case tables first (e.g. a Requirement
  // Inventory / traceability matrix). Grabbing "the first table" picks the
  // wrong one and every mapped cell comes out blank. A Priority column is a
  // reliable signal of an actual test-case table, so prefer those; if the
  // response has multiple test-case tables (e.g. split by phase), merge them.
  function extractTableRows(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const tables = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const headers = splitTableRow(line).map(function (h) { return h.trim(); });
        i += 2; // skip separator
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const cells = splitTableRow(lines[i]);
          const row = {};
          headers.forEach(function (h, idx) {
            row[h] = cells[idx] !== undefined ? cells[idx] : "";
          });
          rows.push(row);
          i++;
        }
        tables.push({ headers: headers, rows: rows });
        continue;
      }
      i++;
    }

    if (!tables.length) return [];

    const testCaseTables = tables.filter(function (t) {
      return t.headers.some(function (h) { return /priority/i.test(h); });
    });
    const chosen = testCaseTables.length ? testCaseTables : [tables[0]];
    return chosen.reduce(function (acc, t) { return acc.concat(t.rows); }, []);
  }

  function findHeaderKey(rowKeys, col) {
    const aliases = COLUMN_ALIASES[col] || [col.toLowerCase()];
    for (let a = 0; a < aliases.length; a++) {
      const key = rowKeys.find(function (k) { return k.toLowerCase() === aliases[a]; });
      if (key) return key;
    }
    return null;
  }

  function exportRowsToExcel(rows) {
    // Map source headers to required output columns by name/alias.
    const outputRows = rows.map(function (row) {
      const rowKeys = Object.keys(row);
      const out = {};
      EXPORT_COLUMNS.forEach(function (col) {
        const key = findHeaderKey(rowKeys, col);
        out[col] = key ? row[key] : "";
      });

      // No dedicated Steps column: some responses embed "**Steps:** ..." text
      // inside another cell (e.g. Description). Pull it out if present.
      if (!out["Steps"]) {
        for (let k = 0; k < rowKeys.length; k++) {
          const match = /\*\*Steps:?\*\*\s*([\s\S]*)/i.exec(row[rowKeys[k]]);
          if (match) {
            out["Steps"] = match[1].trim();
            break;
          }
        }
      }
      return out;
    });

    const ws = XLSX.utils.json_to_sheet(outputRows, { header: EXPORT_COLUMNS });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Test Cases");
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    XLSX.writeFile(wb, "TestCases_" + dateStr + ".xlsx");
  }

  // Toast — small non-blocking notification (red for errors, default for info).
  function showToast(message, isError) {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = "toast" + (isError ? " toast-error" : "");
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () { toast.classList.add("toast-visible"); }, 10);
    setTimeout(function () {
      toast.classList.remove("toast-visible");
      setTimeout(function () { toast.remove(); }, 300);
    }, 3000);
  }

  // ==========================================================================
  // Section: Status bar
  // ==========================================================================

  function updateStatusBar(elapsedMs) {
    const parts = ["Target: " + CONFIG.BASE_URL];

    const modelKeys = Object.keys(CONFIG.MODEL_TWEAKS || {});
    if (modelKeys.length > 0) {
      const first = CONFIG.MODEL_TWEAKS[modelKeys[0]];
      const modelName = first && first.model_name ? first.model_name : modelKeys[0];
      parts.push("Model: " + modelName);
    }

    if (elapsedMs !== null && elapsedMs !== undefined) {
      parts.push("Response: " + (elapsedMs / 1000).toFixed(2) + "s");
    }

    elements.statusBar.textContent = parts.join("  ·  ");
  }

  // ---- Bootstrap -------------------------------------------------------

  // ==========================================================================
  // Section: Session registry (localStorage — persists conversation history)
  // ==========================================================================

  const SESSIONS_KEY = "tcgen_sessions";

  function loadSessions() {
    try {
      return JSON.parse(localStorage.getItem(SESSIONS_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveSessions(sessions) {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  // Called on the first message of a session (creates entry) and every
  // subsequent message (bumps lastUsedAt). Re-renders the sidebar each time.
  function recordSessionMessage(titleCandidate) {
    const sessions = loadSessions();
    const existing = sessions.find(function (s) { return s.id === state.sessionId; });
    if (existing) {
      existing.lastUsedAt = new Date().toISOString();
    } else {
      sessions.unshift({
        id: state.sessionId,
        title: String(titleCandidate).trim().slice(0, 40) || "New Chat",
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
    }
    saveSessions(sessions);
    renderSidebar();
  }

  function getDateGroup(isoString) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const d = new Date(isoString);
    const diff = todayStart - d;
    if (diff <= 0) return "Today";
    if (diff < 86400000) return "Yesterday";
    if (diff < 7 * 86400000) return "Previous 7 Days";
    if (diff < 30 * 86400000) return "Previous 30 Days";
    return "Over 30 Days";
  }

  function formatSessionTime(isoString) {
    const d = new Date(isoString);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    if (d >= todayStart) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function renderSidebar() {
    const list = document.getElementById("sidebar-list");
    if (!list) return;
    const query = (elements.sidebarSearch && elements.sidebarSearch.value || "").trim().toLowerCase();
    let sessions = loadSessions();

    if (query) {
      sessions = sessions.filter(function (s) {
        return s.title.toLowerCase().includes(query);
      });
    }

    if (!sessions.length) {
      list.innerHTML = '<p class="sidebar-empty">' + (query ? "No matching chats." : "No conversations yet.") + "</p>";
      return;
    }

    sessions.sort(function (a, b) {
      return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
    });

    const GROUP_ORDER = [
      "Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Over 30 Days",
    ];
    const groups = {};
    sessions.forEach(function (s) {
      const g = getDateGroup(s.lastUsedAt);
      if (!groups[g]) groups[g] = [];
      groups[g].push(s);
    });

    let html = "";
    GROUP_ORDER.forEach(function (groupName) {
      if (!groups[groupName]) return;
      html += '<div class="sidebar-group-label">' + escapeHtml(groupName) + "</div>";
      groups[groupName].forEach(function (session) {
        const active = session.id === state.sessionId ? " sidebar-item-active" : "";
        html +=
          '<div class="sidebar-item' + active + '" ' +
          'data-session-id="' + escapeHtml(session.id) + '" ' +
          'role="button" tabindex="0">' +
          '<span class="sidebar-item-title">' + escapeHtml(session.title) + "</span>" +
          '<span class="sidebar-item-meta">' + formatSessionTime(session.lastUsedAt) + "</span>" +
          '<button class="sidebar-item-delete" type="button" ' +
          'aria-label="Delete conversation" title="Delete">&#128465;</button>' +
          "</div>";
      });
    });

    list.innerHTML = html;

    list.querySelectorAll(".sidebar-item").forEach(function (item) {
      item.addEventListener("click", function (e) {
        if (e.target.closest(".sidebar-item-delete")) return;
        onSidebarItemClick(item.dataset.sessionId);
      });
      item.querySelector(".sidebar-item-delete").addEventListener("click", function (e) {
        e.stopPropagation();
        onSidebarItemDelete(item.dataset.sessionId);
      });
      item.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); item.click(); }
      });
    });
  }

  // Placeholders replaced in Steps 3 & 4.
  async function onSidebarItemClick(sessionId) {
    if (sessionId === state.sessionId) {
      // Already the active session — just close sidebar on mobile.
      if (window.innerWidth <= 768) {
        document.getElementById("sidebar").classList.add("sidebar-collapsed");
        document.getElementById("sidebar-overlay").classList.remove("overlay-visible");
      }
      return;
    }

    // Close sidebar on mobile before loading.
    if (window.innerWidth <= 768) {
      document.getElementById("sidebar").classList.add("sidebar-collapsed");
      document.getElementById("sidebar-overlay").classList.remove("overlay-visible");
    }

    // Show a spinner while fetching.
    elements.chatMessages.innerHTML = "";
    setExportState(false);
    showTypingIndicator();

    try {
      const messages = await fetchSessionMessages(sessionId);

      // Switch active session so new messages continue this thread.
      state.sessionId = sessionId;
      state.lastRequest = null;
      clearAttachedFile();
      updateStatusBar(null);

      hideTypingIndicator();
      elements.chatMessages.innerHTML = "";

      if (!messages.length) {
        renderEmptyState();
      } else {
        messages.forEach(function (msg) {
          const text = extractMonitorText(msg);
          if (!text) return;
          const sender = String(msg.sender || msg.role || "").toLowerCase();
          if (sender === "user") {
            appendUserMessage(text);
          } else {
            appendAssistantMessage(text);
          }
        });
      }

      renderSidebar(); // update active highlight to loaded session
    } catch (err) {
      hideTypingIndicator();
      elements.chatMessages.innerHTML = "";
      renderEmptyState();
      showToast("Could not load conversation: " + err.message, true);
    }
  }

  // Fetches all messages for a session from Langflow's monitor API.
  // Handles both response shapes: { data: [...] } and plain [...].
  async function fetchSessionMessages(sessionId) {
    let res;
    try {
      res = await fetch(
        CONFIG.BASE_URL + "/api/v1/monitor/messages" +
        "?flow_id=" + encodeURIComponent(CONFIG.FLOW_ID) +
        "&session_id=" + encodeURIComponent(sessionId),
        { headers: { "x-api-key": CONFIG.API_KEY } }
      );
    } catch (e) {
      throw networkError();
    }
    if (!res.ok) throw await httpError("Could not load conversation history", res);
    const data = await res.json();
    return Array.isArray(data) ? data : (data.data || []);
  }

  // Langflow monitor messages vary by version — try all known field locations.
  function extractMonitorText(msg) {
    if (typeof msg.message === "string") return msg.message;
    if (msg.message && typeof msg.message.text === "string") return msg.message.text;
    if (typeof msg.text === "string") return msg.text;
    return "";
  }

  async function onSidebarItemDelete(sessionId) {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;

    // Best-effort: try to remove messages from Langflow's monitor.
    // If the API call fails (e.g. unsupported version), we still clean up locally.
    try {
      await deleteSessionFromMonitor(sessionId);
    } catch (e) {
      // Swallow — local removal below always runs.
    }

    // Remove from registry.
    saveSessions(loadSessions().filter(function (s) { return s.id !== sessionId; }));

    // If the deleted session was the active one, start fresh.
    if (sessionId === state.sessionId) {
      elements.chatMessages.innerHTML = "";
      state.sessionId = crypto.randomUUID();
      state.lastRequest = null;
      clearAttachedFile();
      setExportState(false);
      updateStatusBar(null);
      renderEmptyState();
    }

    renderSidebar();
    showToast("Conversation deleted.");
  }

  // Asks Langflow to drop all monitor messages for the session.
  // Treats 404 as success — older Langflow versions may not expose this endpoint.
  async function deleteSessionFromMonitor(sessionId) {
    let res;
    try {
      res = await fetch(
        CONFIG.BASE_URL + "/api/v1/monitor/messages" +
        "?session_id=" + encodeURIComponent(sessionId) +
        "&flow_id=" + encodeURIComponent(CONFIG.FLOW_ID),
        { method: "DELETE", headers: { "x-api-key": CONFIG.API_KEY } }
      );
    } catch (e) {
      throw networkError();
    }
    if (!res.ok && res.status !== 404) {
      throw await httpError("Could not delete messages from Langflow", res);
    }
  }

  function initSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");

    // Start collapsed on mobile so it doesn't cover the chat on load.
    if (window.innerWidth <= 768) {
      sidebar.classList.add("sidebar-collapsed");
    }

    document.getElementById("btn-sidebar-toggle").addEventListener("click", function () {
      const isMobile = window.innerWidth <= 768;
      const nowCollapsed = sidebar.classList.toggle("sidebar-collapsed");
      if (isMobile) {
        overlay.classList.toggle("overlay-visible", !nowCollapsed);
      }
    });

    overlay.addEventListener("click", function () {
      sidebar.classList.add("sidebar-collapsed");
      overlay.classList.remove("overlay-visible");
    });

    document.getElementById("btn-new-chat").addEventListener("click", function () {
      // On mobile: close sidebar after tapping New Chat
      if (window.innerWidth <= 768) {
        sidebar.classList.add("sidebar-collapsed");
        overlay.classList.remove("overlay-visible");
      }
      elements.chatMessages.innerHTML = "";
      state.sessionId = crypto.randomUUID();
      state.lastRequest = null;
      clearAttachedFile();
      setExportState(false);
      updateStatusBar(null);
      renderEmptyState();
      renderSidebar(); // clears active highlight
    });

    if (elements.sidebarSearch) {
      elements.sidebarSearch.addEventListener("input", renderSidebar);
    }

    // Jira connector
    elements.jiraBtn.addEventListener("click", function () {
      if (!elements.jiraPanel.hidden) {
        hideJiraPanel();
      } else {
        showJiraFetchPanel();
      }
    });
    document.getElementById("jira-close-btn").addEventListener("click", hideJiraPanel);
    document.getElementById("jira-close-btn-2").addEventListener("click", hideJiraPanel);
    document.getElementById("jira-change-btn").addEventListener("click", function () {
      elements.jiraImportedView.hidden = true;
      elements.jiraFetchView.hidden = false;
      elements.jiraIdInput.focus();
    });
    elements.jiraFetchBtn.addEventListener("click", fetchJiraTicket);
    elements.jiraIdInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") fetchJiraTicket();
    });
    elements.jiraGenerateBtn.addEventListener("click", sendJiraStory);
  }

  function init() {
    initSidebar();
    initTheme();
    initModelSelector();
    updateStatusBar(null);
    const nameEl = document.getElementById("assistant-name-header");
    if (nameEl) nameEl.textContent = ASSISTANT_NAME;
    elements.chatInput.placeholder = "I'm " + ASSISTANT_NAME + " — type your user story here";
    renderEmptyState();
    renderSidebar();
  }

  init();
})();
