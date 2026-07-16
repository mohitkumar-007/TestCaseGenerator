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
    typingTextTimer: null,
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

  // File mode step 1: upload the file (PDF / TXT / MD) and return the server-side path Langflow
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

  // ==========================================================================
  // Section: Test-case structured view
  // Detects TC tables in AI markdown and renders a rich phase/table UI.
  // ==========================================================================

  // Returns the index of the first header cell matching any pattern, or -1.
  function findTCCol(headerCells, patterns) {
    for (var ci = 0; ci < headerCells.length; ci++) {
      var h = headerCells[ci].trim();
      if (patterns.some(function (p) { return p.test(h); })) return ci;
    }
    return -1;
  }

  // Scans markdown for pipe-tables that have both an ID-like column and a
  // Priority column, collecting them into phase objects grouped by any
  // preceding H1-H3 header.  Returns an array of phases, or null.
  function extractTestCasePhases(md) {
    var lines = String(md).replace(/\r\n/g, "\n").split("\n");
    var sections = [];   // ordered: { type:'markdown', content } | { type:'phase', data }
    var mdBuffer = [];   // accumulates lines for the current markdown block
    var pendingTitle = null;
    var pendingHdrLine = null; // buffered header until we know what follows it
    var i = 0;

    function flushMd() {
      var content = mdBuffer.join("\n").trim();
      if (content) sections.push({ type: "markdown", content: content });
      mdBuffer = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      // ---- Section header -------------------------------------------------
      var hm = /^#{1,3}\s+(.+)$/.exec(line);
      if (hm) {
        if (pendingHdrLine !== null) mdBuffer.push(pendingHdrLine);
        pendingTitle = hm[1].trim();
        pendingHdrLine = line;
        i++;
        continue;
      }

      // ---- Table start ----------------------------------------------------
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        var headerCells = splitTableRow(line).map(function (h) { return h.trim(); });
        var idColT  = findTCCol(headerCells, [/^(tc[\s_-]?id|test[\s_-]?case[\s_-]?id|id)$/i]);
        var priColT = findTCCol(headerCells, [/^(priority|pri|severity|sev)$/i]);

        if (idColT === -1 || priColT === -1) {
          // Non-TC table: resolve pending header into markdown, then flush as its own section
          if (pendingHdrLine !== null) { mdBuffer.push(pendingHdrLine); pendingHdrLine = null; pendingTitle = null; }
          mdBuffer.push(line);
          mdBuffer.push(lines[i + 1]);
          i += 2;
          while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { mdBuffer.push(lines[i]); i++; }
          flushMd();
          continue;
        }

        // TC table: pendingHdrLine is the phase title — do NOT flush it into markdown
        flushMd();              // flush only mdBuffer (blank lines etc.), not pendingHdrLine
        pendingHdrLine = null;  // consumed as TC title
        i += 2;

        var sumCol = findTCCol(headerCells, [/^(summary|title|description|test[\s_-]?case([\s_-]?name)?|scenario|test[\s_-]?scenario)$/i]);
        var preCol = findTCCol(headerCells, [/^(pre[\s_-]?conditions?|preconditions?|prerequisites?|initial[\s_-]?conditions?|setup)$/i]);
        var stpCol = findTCCol(headerCells, [
          /^(steps?|test[\s_-]?steps?|test[\s_-]?case[\s_-]?steps?|action[\s_-]?steps?|execution[\s_-]?steps?|testing[\s_-]?steps?|procedure)$/i,
          /pre[\s_-]?conditions?[\s_&+,\/]+steps?/i,
          /steps?[\s_&+,\/]+pre[\s_-]?conditions?/i
        ]);
        var expCol = findTCCol(headerCells, [/^(expected[\s_-]?results?|expected[\s_-]?output|expected[\s_-]?behavior|outcome|pass[\s_-]?criteria)$/i]);
        var covCol = findTCCol(headerCells, [/^(requirements?|req[\s_-]?id|covers|coverage|traceability|maps?[\s_-]?to)$/i]);
        var catCol = findTCCol(headerCells, [/^(category|test[\s_-]?category|test[\s_-]?type|type|test[\s_-]?classification)$/i]);

        if (stpCol === -1) {
          var usedCols = [idColT, priColT, sumCol, preCol, expCol, covCol, catCol].filter(function (c) { return c >= 0; });
          for (var fb = 0; fb < headerCells.length; fb++) {
            if (usedCols.indexOf(fb) === -1) { stpCol = fb; break; }
          }
        }

        var phase = { title: pendingTitle || "Test Cases", rows: [] };
        pendingTitle = null;

        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          var cells = splitTableRow(lines[i]);
          var get = function (col) { return (col >= 0 && cells[col] !== undefined) ? cells[col].trim() : ""; };
          phase.rows.push({
            id: get(idColT), summary: get(sumCol), coverage: get(covCol),
            category: get(catCol),
            preconditions: get(preCol), steps: get(stpCol),
            expectedResult: get(expCol), priority: get(priColT),
          });
          i++;
        }
        if (phase.rows.length > 0) sections.push({ type: "phase", data: phase });
        continue;
      }

      // ---- Blank line -----------------------------------------------------
      // Do NOT resolve pendingHdrLine for blank lines — the heading might still
      // precede a TC table that we haven't seen yet.
      if (line.trim() === "") {
        mdBuffer.push(line);
        i++;
        continue;
      }

      // ---- Regular non-blank line -----------------------------------------
      // Now we know the pending header is NOT followed by a TC table
      if (pendingHdrLine !== null) { mdBuffer.push(pendingHdrLine); pendingHdrLine = null; }
      mdBuffer.push(line);
      i++;
    }

    if (pendingHdrLine !== null) mdBuffer.push(pendingHdrLine);
    flushMd();

    var hasPhases = sections.some(function (s) { return s.type === "phase"; });
    return hasPhases ? sections : null;
  }

  // Renders an array of TC phases as a structured DOM element.
  function renderTestCasePhases(phases) {
    var wrap = document.createElement("div");
    wrap.className = "tc-phases-wrap";

    phases.forEach(function (phase) {
      var phaseEl = document.createElement("div");
      phaseEl.className = "tc-phase";

      var counts = { p0: 0, p1: 0, p2: 0, other: 0 };
      phase.rows.forEach(function (r) {
        var p = (r.priority || "").toLowerCase();
        if (p === "p0" || p === "critical") counts.p0++;
        else if (p === "p1" || p === "high")  counts.p1++;
        else if (p === "p2" || p === "medium") counts.p2++;
        else counts.other++;
      });

      var hdr = document.createElement("div");
      hdr.className = "tc-phase-header";
      hdr.innerHTML =
        '<span class="tc-phase-title">' + escapeHtml(phase.title) + "</span>" +
        '<span class="tc-count-badge">' + phase.rows.length + " case" + (phase.rows.length !== 1 ? "s" : "") + "</span>" +
        (counts.p0    ? '<span class="tc-pri-pill tc-pill-p0">P0\u00b7' + counts.p0    + "</span>" : "") +
        (counts.p1    ? '<span class="tc-pri-pill tc-pill-p1">P1\u00b7' + counts.p1    + "</span>" : "") +
        (counts.p2    ? '<span class="tc-pri-pill tc-pill-p2">P2\u00b7' + counts.p2    + "</span>" : "") +
        (counts.other ? '<span class="tc-pri-pill tc-pill-other">P3\u00b7' + counts.other + "</span>" : "") +
        '<button type="button" class="tc-copy-phase-btn">\u229e Copy phase</button>';

      hdr.querySelector(".tc-copy-phase-btn").addEventListener("click", function () {
        var text = phase.rows.map(function (r) {
          var out = r.id + (r.summary ? " \u2014 " + r.summary : "");
          if (r.preconditions) out += "\nPre: " + r.preconditions;
          if (r.steps)         out += "\nSteps: " + r.steps;
          if (r.expectedResult) out += "\nExpected: " + r.expectedResult;
          out += "\nPriority: " + r.priority;
          return out;
        }).join("\n\n");
        navigator.clipboard.writeText(text);
        showToast("Phase copied.");
      });
      phaseEl.appendChild(hdr);

      var tWrap = document.createElement("div");
      tWrap.className = "tc-table-wrap";
      var table = document.createElement("table");
      table.className = "tc-table";

      // Only show CATEGORY column when at least one row has a value
      var hasCategory = phase.rows.some(function (r) { return r.category; });

      var thead = document.createElement("thead");
      thead.innerHTML = "<tr><th>ID</th><th>SUMMARY</th>" +
        (hasCategory ? "<th>CATEGORY</th>" : "") +
        "<th>PRE-CONDITIONS &amp; STEPS</th><th>EXPECTED RESULT</th><th>PRI</th></tr>";
      table.appendChild(thead);

      var tbody = document.createElement("tbody");
      phase.rows.forEach(function (row) {
        var tr = document.createElement("tr");

        var tdId = document.createElement("td");
        tdId.className = "tc-td tc-id-cell";
        tdId.textContent = row.id;

        var tdSum = document.createElement("td");
        tdSum.className = "tc-td tc-summary-cell";
        // Extract inline "(Covers: R1)" from summary if no dedicated coverage column
        var summaryText = row.summary || "";
        var coverageText = row.coverage || "";
        if (!coverageText) {
          var coversMatch = /\s*\(?[Cc]overs?:?\s*([^)]+?)\)?\s*$/i.exec(summaryText);
          if (coversMatch) {
            coverageText = "Covers " + coversMatch[1].trim();
            summaryText = summaryText.slice(0, coversMatch.index).trim();
          }
        }
        tdSum.innerHTML = '<div class="tc-sum-title">' + renderInline(summaryText) + "</div>" +
          (coverageText ? '<div class="tc-coverage-tag">' + escapeHtml(coverageText) + "</div>" : "");

        // Category cell (only when phase has categories)
        var tdCat;
        if (hasCategory) {
          tdCat = document.createElement("td");
          tdCat.className = "tc-td tc-category-cell";
          tdCat.innerHTML = row.category
            ? '<span class="tc-category-badge">' + escapeHtml(row.category) + "</span>"
            : "";
        }

        var tdSteps = document.createElement("td");
        tdSteps.className = "tc-td tc-steps-cell";
        var sHtml = "";
        if (row.preconditions) {
          sHtml += '<p class="tc-pre-line"><span class="tc-pre-label">PRE </span>' + renderInline(row.preconditions) + "</p>";
        }
        if (row.steps) {
          var stepsText = row.steps;
          var preFromCombined = "";

          if (!row.preconditions) {
            // Split at explicit "Steps:" label — avoids splitting on things like "P3) are seated"
            var stepsLabelIdx = stepsText.search(/\*{0,2}steps?[\s]*:/i);
            if (stepsLabelIdx > 0) {
              var beforeSteps = stepsText.slice(0, stepsLabelIdx).trim();
              var prePrefix = /^\*{0,2}pre[\s_-]?conditions?[:\s*]+([\s\S]+)/i.exec(beforeSteps);
              preFromCombined = (prePrefix ? prePrefix[1] : beforeSteps).trim().replace(/\.?\s*$/, "");
              stepsText = stepsText.slice(stepsLabelIdx).replace(/^\*{0,2}steps?[\s]*:[:\s\*]*/i, "").trim();
            } else {
              var preOnly = /^\*{0,2}pre[\s_-]?conditions?[:\s*]+([\s\S]+)/i.exec(stepsText.trim());
              if (preOnly) { preFromCombined = preOnly[1].trim().replace(/\.?\s*$/, ""); stepsText = ""; }
            }
          }

          if (preFromCombined) {
            sHtml += '<p class="tc-pre-line"><span class="tc-pre-label">PRE </span>' + renderInline(preFromCombined) + "</p>";
            preFromCombined = "";
          }

          // Only split into numbered steps when stepsText actually starts with a step
          // number pattern (e.g. "1. ", "2) "). If it starts with prose (e.g. "Complete Deal 1."),
          // treat the whole thing as a single plain-text step to avoid false splits.
          var _sparts = [];
          if (/^\d+[\.)][ \t]/.test(stepsText)) {
            var _sre = /\d+[\.)][ \t]/g, _sm2, _slast = 0;
            while ((_sm2 = _sre.exec(stepsText)) !== null) {
              var _sp = _sm2.index, _sprev = _sp > 0 ? stepsText[_sp - 1] : "";
              if (/[a-zA-Z]/.test(_sprev)) continue;
              if (_sp > _slast) { var _sc = stepsText.slice(_slast, _sp).trim(); if (_sc) _sparts.push(_sc); }
              _slast = _sp;
            }
            var _stail = stepsText.slice(_slast).trim(); if (_stail) _sparts.push(_stail);
          } else if (stepsText) {
            _sparts.push(stepsText);
          }
          var parts = _sparts.map(function (s) { return s.replace(/^\d+[\.)][ \t]+/, "").trim(); }).filter(function (s) { return s && !/^\d+[\.)]\s*$/.test(s); });

          // Post-split: AI often puts "**Pre-Conditions:** text **Steps:**" as the FIRST numbered step.
          // Detect and extract it here instead.
          if (parts.length > 0 && !row.preconditions) {
            var fp = parts[0];
            if (/^\*{0,2}pre[\s_-]?conditions?/i.test(fp)) {
              var condText = fp
                .replace(/^\*{0,2}pre[\s_-]?conditions?[:\s*]+/i, "")  // strip "**Pre-Conditions:**" or "Pre-Conditions:" prefix
                .replace(/\s*\*{0,2}steps?[:\s*]*$/i, "")               // strip trailing "**Steps:**" or "Steps:" suffix
                .trim()
                .replace(/\.+$/, "");
              if (condText) {
                sHtml += '<p class="tc-pre-line"><span class="tc-pre-label">PRE </span>' + renderInline(condText) + "</p>";
              }
              parts.shift(); // consumed — not a real step
            }
          }

          if (parts.length > 1) {
            sHtml += '<div class="tc-steps-list">' + parts.map(function (s, idx) {
              return '<div class="tc-step-row"><span class="tc-step-n">' + (idx + 1) + '</span><span class="tc-step-text">' + renderInline(s) + "</span></div>";
            }).join("") + "</div>";
          } else if (parts.length === 1) {
            sHtml += '<p class="tc-steps-plain">' + renderInline(parts[0]) + "</p>";
          } else if (stepsText) {
            sHtml += '<p class="tc-steps-plain">' + renderInline(stepsText) + "</p>";
          }
        }
        tdSteps.innerHTML = sHtml || '<span class="tc-na">\u2014</span>';

        var tdExp = document.createElement("td");
        tdExp.className = "tc-td tc-expected-cell";
        tdExp.innerHTML = '<div class="tc-expected-box">' + renderInline(row.expectedResult || "\u2014") + "</div>";

        var tdPri = document.createElement("td");
        tdPri.className = "tc-td tc-pri-cell";
        var pl = (row.priority || "").toLowerCase();
        var bc = pl === "p0" || pl === "critical" ? "tc-badge-p0" :
                 pl === "p1" || pl === "high"     ? "tc-badge-p1" :
                 pl === "p2" || pl === "medium"   ? "tc-badge-p2" : "tc-badge-other";
        tdPri.innerHTML = '<span class="tc-badge ' + bc + '">' + escapeHtml(row.priority || "") + "</span>";

        tr.appendChild(tdId); tr.appendChild(tdSum);
        if (hasCategory && tdCat) tr.appendChild(tdCat);
        tr.appendChild(tdSteps);
        tr.appendChild(tdExp); tr.appendChild(tdPri);
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      tWrap.appendChild(table);
      phaseEl.appendChild(tWrap);
      wrap.appendChild(phaseEl);
    });
    return wrap;
  }

  // Renders assistant markdown, using the rich per-step test-case table UI for
  // any TC phase tables detected, and the plain markdown renderer for everything
  // else, preserving the original order of sections.
  function renderAssistantContent(markdownText) {
    const container = document.createElement("div");
    const sections = extractTestCasePhases(markdownText);
    if (!sections) {
      container.innerHTML = renderMarkdown(markdownText);
      return container;
    }
    sections.forEach(function (s) {
      if (s.type === "phase") {
        container.appendChild(renderTestCasePhases([s.data]));
      } else {
        const mdEl = document.createElement("div");
        mdEl.innerHTML = renderMarkdown(s.content);
        container.appendChild(mdEl);
      }
    });
    return container;
  }

  function appendAssistantMessage(markdownText) {
    const el = document.createElement("div");
    el.className = "message message-assistant";
    el.dataset.rawMarkdown = markdownText;

    // Render AI response as plain markdown, promoting any TC tables to the
    // richer per-step phase view.
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.appendChild(renderAssistantContent(markdownText));
    el.appendChild(bubble);

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = ASSISTANT_NAME + " · " + nowTimeString();
    el.appendChild(meta);

    // ---- Action buttons row (Retry / Copy / Like / Dislike) ----
    const actionsRow = document.createElement("div");
    actionsRow.className = "msg-actions";

    // 1. Retry
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "msg-action-btn";
    retryBtn.setAttribute("aria-label", "Retry");
    retryBtn.title = "Retry";
    retryBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.07"/></svg>';
    retryBtn.addEventListener("click", function () {
      onRetryAssistantMessage(el);
    });

    // 2. Copy
    const SVG_COPY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const SVG_CHECK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "msg-action-btn";
    copyBtn.setAttribute("aria-label", "Copy message");
    copyBtn.title = "Copy message";
    copyBtn.innerHTML = SVG_COPY;
    copyBtn.addEventListener("click", function () {
      navigator.clipboard.writeText(markdownText).then(function () {
        copyBtn.innerHTML = SVG_CHECK;
        setTimeout(function () { copyBtn.innerHTML = SVG_COPY; }, 1500);
      });
    });

    // 3. Like
    const likeBtn = document.createElement("button");
    likeBtn.type = "button";
    likeBtn.className = "msg-action-btn";
    likeBtn.setAttribute("aria-label", "Like");
    likeBtn.title = "Like";
    likeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
    likeBtn.addEventListener("click", function () {
      const nowLiked = likeBtn.classList.toggle("msg-action-liked");
      if (nowLiked) dislikeBtn.classList.remove("msg-action-disliked");
    });

    // 4. Dislike
    const dislikeBtn = document.createElement("button");
    dislikeBtn.type = "button";
    dislikeBtn.className = "msg-action-btn";
    dislikeBtn.setAttribute("aria-label", "Dislike");
    dislikeBtn.title = "Dislike";
    dislikeBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';
    dislikeBtn.addEventListener("click", function () {
      const nowDisliked = dislikeBtn.classList.toggle("msg-action-disliked");
      if (nowDisliked) likeBtn.classList.remove("msg-action-liked");
    });

    actionsRow.appendChild(retryBtn);
    actionsRow.appendChild(copyBtn);
    actionsRow.appendChild(likeBtn);
    actionsRow.appendChild(dislikeBtn);
    el.appendChild(actionsRow);

    elements.chatMessages.appendChild(el);
    scrollToBottom();

    // Enable export / copy-all if this response contains a markdown table
    if (/\|.*\|/.test(markdownText)) setExportState(true);

    return el;
  }

  const TYPING_PHRASES = [
    "Sit relax, generation is in progress",
    "Piloting your test cases",
    "On it",
    "Charting the test flow",
    "Generating soon",
    "Some more time please",
    "Taxiing to takeoff",
    "Almost there",
    "Analysing the requirements",
    "Don't go anywhere, just a moment",
    "Cleared for takeoff, building your test suite...",
    "Cruising altitude reached, mapping test scenarios...",
    "Navigating through the edge cases...",
    "Flight path confirmed, drafting test steps...",
    "Preparing for landing, finalizing your test cases...",
    "Connecting the dots between requirements...",
    "Brainstorming edge cases...",
    "Compiling your test scenarios...",
    "Structuring the test suite...",
    "Scanning logic for potential bugs...",
    "Synthesizing test steps and expected results...",
    "Validating test coverage...",
    "Grab a sip of coffee, we're doing the heavy lifting...",
    "Working our magic, just a few seconds more...",
    "Putting the finishing touches on your test cases...",
    "Hang tight, weaving your test cases together...",
    "Doing the busywork so you don't have to...",
    "Almost done! Just dotting the i's and crossing the t's...",
    "Crunching the requirements...",
    "Drafting test steps...",
    "Brewing test cases...",
    "Brewing test cases...",
    "Thinking...",
    "Connecting...",
    "Validating logic..."
  ];

  function showTypingIndicator() {
    const el = document.createElement("div");
    el.className = "message message-assistant message-typing";
    el.id = "typing-indicator";
    el.innerHTML =
      '<div class="typing-progress">' +
        '<span class="typing-logo" aria-hidden="true">&#9992;&#65039;</span>' +
        '<span class="typing-text" id="typing-text">' + TYPING_PHRASES[0] + '&hellip;</span>' +
      '</div>' +
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

    // Cycle through phrases so the indicator never looks stuck on one message
    let phraseIndex = 0;
    if (state.typingTextTimer) clearInterval(state.typingTextTimer);
    state.typingTextTimer = setInterval(function () {
      const textEl = document.getElementById("typing-text");
      if (!textEl) return;
      phraseIndex = (phraseIndex + 1) % TYPING_PHRASES.length;
      textEl.classList.add("typing-text-swap");
      setTimeout(function () {
        textEl.textContent = TYPING_PHRASES[phraseIndex] + "…";
        textEl.classList.remove("typing-text-swap");
      }, 220);
    }, 2200);
  }

  function hideTypingIndicator() {
    if (state.typingTextTimer) {
      clearInterval(state.typingTextTimer);
      state.typingTextTimer = null;
    }
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

  // ---- Retry / Regenerate -------------------------------------------------------

  // Removes this assistant message (and any subsequent messages) and re-runs
  // the generation using the preceding user message text.
  function onRetryAssistantMessage(assistantEl) {
    const children = Array.from(elements.chatMessages.children);
    const assistantIdx = children.indexOf(assistantEl);
    if (assistantIdx === -1) return;

    // Walk backwards to find the user message that triggered this response.
    let userMsgEl = null;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (children[i].classList.contains("message-user")) {
        userMsgEl = children[i];
        break;
      }
    }
    if (!userMsgEl) return;
    const userText = userMsgEl.dataset.messageText;
    if (!userText) return;

    // Remove the assistant message and anything that came after it.
    for (let i = children.length - 1; i >= assistantIdx; i--) {
      children[i].remove();
    }

    regenerateResponse(userText);
  }

  // Re-runs text generation for `text` without adding a new user bubble.
  async function regenerateResponse(text) {
    state.lastRequest = function () { regenerateResponse(text); };
    state.abortController = new AbortController();
    showTypingIndicator();
    elements.sendBtn.disabled = true;
    const t0 = Date.now();
    try {
      const data = await runTextGeneration(text, state.abortController.signal);
      hideTypingIndicator();
      const replyText = extractMessageText(data);
      saveLocalMessage(state.sessionId, "assistant", replyText);
      appendAssistantMessage(replyText);
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
    saveLocalMessage(state.sessionId, "user", text);
    recordSessionMessage(text);
    state.lastRequest = function () { sendUserStory(text); };
    state.abortController = new AbortController();
    showTypingIndicator();
    elements.sendBtn.disabled = true;
    const t0 = Date.now();
    try {
      const data = await runTextGeneration(text, state.abortController.signal);
      hideTypingIndicator();
      const replyText = extractMessageText(data);
      saveLocalMessage(state.sessionId, "assistant", replyText);
      appendAssistantMessage(replyText);
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
    const userMsg = "Analyzing " + file.name + "...";
    appendUserMessage(userMsg);
    saveLocalMessage(state.sessionId, "user", userMsg);
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
      const replyText = extractMessageText(data);
      saveLocalMessage(state.sessionId, "assistant", replyText);
      appendAssistantMessage(replyText);
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
    const userMsg = "Generate test cases from imported ticket " + ticketId + "...";
    appendUserMessage(userMsg);
    saveLocalMessage(state.sessionId, "user", userMsg);
    recordSessionMessage(ticketId);
    state.lastRequest = function () { runJiraStorySend(jiraStoryText, ticketId); };
    state.abortController = new AbortController();
    showTypingIndicator();
    elements.sendBtn.disabled = true;
    const t0 = Date.now();
    try {
      const data = await runJiraStoryGeneration(jiraStoryText, ticketId, state.abortController.signal);
      hideTypingIndicator();
      const replyText = extractMessageText(data);
      saveLocalMessage(state.sessionId, "assistant", replyText);
      appendAssistantMessage(replyText);
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
    return /\.(pdf|txt|md)$/i.test(file.name);
  }

  function setAttachedFile(file) {
    if (!file) return;
    if (!isAcceptedFile(file)) {
      appendErrorMessage(new Error("Only PDF, TXT, and MD files are supported."), null);
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
      title: "Fund Transfer",
      subtitle: "IMPS/NEFT transfer between accounts",
      text:
        "As a bank customer, I want to transfer funds between my linked " +
        "accounts so that I can move money without visiting a branch. The " +
        "transfer should validate available balance, daily limits, and " +
        "require OTP confirmation before completing.",
    },
    {
      domain: "Insurance",
      title: "Policy Claim Submission",
      subtitle: "First-notice-of-loss claim flow",
      text:
        "As a policyholder, I want to submit a claim for a covered incident " +
        "with supporting documents so that my claim can be reviewed and " +
        "processed. The system should validate policy status, required " +
        "documents, and claim deadlines before accepting the submission.",
    },
    {
      domain: "Finance",
      title: "Loan EMI Calculation",
      subtitle: "EMI schedule for a term loan",
      text:
        "As a loan applicant, I want to calculate my monthly EMI based on " +
        "loan amount, interest rate, and tenure so that I can evaluate " +
        "affordability before applying. The calculator should handle edge " +
        "cases like zero interest and validate input ranges.",
    },
  ];

  // Renders the centered welcome + sample-story cards shown before the
  // first message. Cards are hidden behind a "Try an example" toggle.
  function renderEmptyState() {
    // Revert composer placeholder to the default welcome prompt
    elements.chatInput.placeholder = "I\u2019m " + ASSISTANT_NAME + " \u2014 type your user story here";

    // Apply vertically-centered empty layout
    elements.chatPanel.classList.add("is-empty");

    const el = document.createElement("div");
    el.className = "empty-state";
    el.id = "empty-state";

    const SEND_ICON = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

    el.innerHTML =
      '<div class="empty-state-inner">' +
        '<div class="empty-state-badge" aria-hidden="true">✈️</div>' +
        '<h2 class="empty-state-title">' + escapeHtml(ASSISTANT_NAME) + "</h2>" +
        '<p class="empty-state-message">Paste a user story, attach a PRD, or pull from Jira \u2014 I\u2019ll return structured, execution-ready test cases.</p>' +
      "</div>";

    elements.chatMessages.appendChild(el);

    // Render "Try an example" toggle + cards into the footer slot (below the composer)
    var footer = document.getElementById("composer-footer");
    if (!footer) return;

    const cardsHtml = SAMPLE_STORIES.map(function (story, idx) {
      return (
        '<button type="button" class="sample-card" data-story-index="' + idx + '">' +
          '<span class="sample-card-domain">' + escapeHtml(story.domain) + "</span>" +
          '<span class="sample-card-title">' + escapeHtml(story.title) + "</span>" +
          '<span class="sample-card-subtitle">' + escapeHtml(story.subtitle) + "</span>" +
        "</button>"
      );
    }).join("");

    footer.innerHTML =
      '<button type="button" class="try-example-btn" id="try-example-btn">' +
        'Try an example <span class="try-example-chevron" aria-hidden="true">&#9660;</span>' +
      '</button>' +
      '<div class="sample-cards" id="sample-cards-panel" hidden>' + cardsHtml + '</div>';
    footer.removeAttribute("hidden");

    const tryBtn = footer.querySelector("#try-example-btn");
    const cardsPanel = footer.querySelector("#sample-cards-panel");
    tryBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      const opening = cardsPanel.hasAttribute("hidden");
      if (opening) {
        cardsPanel.removeAttribute("hidden");
        tryBtn.innerHTML = 'Try an example <span class="try-example-chevron" aria-hidden="true">&#9650;</span>';
        setTimeout(function () {
          document.addEventListener("click", function closeOnOutside(ev) {
            var f = document.getElementById("composer-footer");
            if (!f || !f.contains(ev.target)) {
              cardsPanel.setAttribute("hidden", "");
              tryBtn.innerHTML = 'Try an example <span class="try-example-chevron" aria-hidden="true">&#9660;</span>';
              document.removeEventListener("click", closeOnOutside);
            }
          });
        }, 0);
      } else {
        cardsPanel.setAttribute("hidden", "");
        tryBtn.innerHTML = 'Try an example <span class="try-example-chevron" aria-hidden="true">&#9660;</span>';
      }
    });

    footer.querySelectorAll(".sample-card").forEach(function (btn) {
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
    // Restore normal chat layout
    elements.chatPanel.classList.remove("is-empty");
    // Hide and clear the footer slot
    var footer = document.getElementById("composer-footer");
    if (footer) { footer.setAttribute("hidden", ""); footer.innerHTML = ""; }
    // Switch composer to follow-up prompt once the chat is active
    elements.chatInput.placeholder = "Ask a follow-up, or paste the next user story...";
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
    const exportCsvBtn = document.getElementById("btn-export-csv");
    const copyAllBtn = document.getElementById("btn-copy-all");
    if (exportBtn) exportBtn.disabled = !enabled;
    if (exportCsvBtn) exportCsvBtn.disabled = !enabled;
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

  // Export to CSV.
  // Parses the LAST assistant message's markdown table(s), same as the Excel export.
  document.getElementById("btn-export-csv").addEventListener("click", function () {
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
    exportRowsToCsv(rows);
  });

  // Maps source columns to the required output columns by header name.
  // Output columns: TC ID | Description | Steps | Priority | Expected Result
  const EXPORT_COLUMNS = ["TC ID", "Description", "Steps", "Priority", "Expected Result"];

  // CSV export includes a dedicated Summary column alongside Description.
  const CSV_EXPORT_COLUMNS = ["TC ID", "Summary", "Description", "Steps", "Priority", "Expected Result"];

  // Model output doesn't always use these exact header names (e.g. "Test Case ID"
  // instead of "TC ID"). Listed in priority order per target column.
  // Summary and Description share fallback aliases since responses often only
  // provide one of the two — falling back keeps both columns populated instead
  // of leaving one blank.
  const COLUMN_ALIASES = {
    "TC ID": ["tc id", "test case id", "test id", "id"],
    "Summary": ["summary", "title", "description"],
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

  // Splits a combined "**Pre-Conditions:** ... **Steps:** 1. ... 2. ..." blob
  // (common when the model crams both into one Description-like cell instead
  // of using separate columns) into { pre, steps: [...] }. Returns null when
  // the text doesn't start with a recognizable Pre-Conditions/Steps marker, so
  // callers can leave unrelated free-text cells untouched.
  function splitPreconditionsAndSteps(raw) {
    let text = String(raw || "").trim();
    if (!/^\*{0,2}pre[\s_-]?conditions?[:\s*]/i.test(text) && !/^\*{0,2}steps?[:\s*]/i.test(text)) {
      return null;
    }

    let pre = "";
    const preLabelMatch = /^\*{0,2}pre[\s_-]?conditions?[:\s*]+/i.exec(text);
    if (preLabelMatch) {
      const rest = text.slice(preLabelMatch[0].length);
      // Prefer splitting at an explicit "**Steps:**" label; only fall back to
      // splitting at the first numbered step when no such label exists, since
      // preconditions can themselves contain "N." (e.g. "cooldown = 3.").
      const stepsLabelMatch = /\*{0,2}steps?[:\s*]/i.exec(rest);
      if (stepsLabelMatch) {
        pre = rest.slice(0, stepsLabelMatch.index).trim().replace(/\.?\s*$/, "");
        text = rest.slice(stepsLabelMatch.index);
      } else {
        const numberedMatch = /\d+[\.)][\s]/.exec(rest);
        if (numberedMatch) {
          pre = rest.slice(0, numberedMatch.index).trim().replace(/\.?\s*$/, "");
          text = rest.slice(numberedMatch.index);
        } else {
          pre = rest.trim().replace(/\.?\s*$/, "");
          text = "";
        }
      }
    }

    const stepsMatch = /^\*{0,2}steps?[:\s*]*([\s\S]*)/i.exec(text.trim());
    const stepsText = stepsMatch ? stepsMatch[1].trim() : text.trim();
    const parts = stepsText.split(/(?=\d+[\.)][\s])/).map(function (s) {
      return s.replace(/^\d+[\.)][\s]+/, "").trim();
    }).filter(Boolean);

    return { pre: pre, steps: parts.length ? parts : (stepsText ? [stepsText] : []) };
  }

  // Maps source headers to the given output columns by name/alias.
  function mapRowsToColumns(rows, columns) {
    return rows.map(function (row) {
      const rowKeys = Object.keys(row);
      const out = {};
      columns.forEach(function (col) {
        const key = findHeaderKey(rowKeys, col);
        out[col] = key ? row[key] : "";
      });

      // Some responses cram "**Pre-Conditions:** ... **Steps:** 1. ... 2. ..."
      // into a single Description-like cell instead of separate columns. Split
      // it so Description holds only the preconditions and Steps gets one
      // line per numbered step instead of one run-on line.
      const descKey = findHeaderKey(rowKeys, "Description");
      const split = descKey ? splitPreconditionsAndSteps(row[descKey]) : null;
      if (split) {
        if (columns.indexOf("Description") !== -1 && split.pre) {
          out["Description"] = "Pre-Conditions: " + split.pre;
        }
        if (columns.indexOf("Steps") !== -1 && split.steps.length) {
          out["Steps"] = split.steps.map(function (s, idx) { return (idx + 1) + ". " + s; }).join("\n");
        }
      }
      return out;
    });
  }

  function exportRowsToExcel(rows) {
    const outputRows = mapRowsToColumns(rows, EXPORT_COLUMNS);
    const ws = XLSX.utils.json_to_sheet(outputRows, { header: EXPORT_COLUMNS });

    // Widen columns and wrap text so embedded newlines (e.g. multi-line Steps)
    // render as separate lines instead of one flattened row.
    ws["!cols"] = EXPORT_COLUMNS.map(function (col) {
      return { wch: col === "Description" || col === "Steps" || col === "Expected Result" ? 50 : 16 };
    });
    const range = XLSX.utils.decode_range(ws["!ref"]);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
        if (cell) cell.s = { alignment: { wrapText: true, vertical: "top" } };
      }
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Test Cases");
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    XLSX.writeFile(wb, "TestCases_" + dateStr + ".xlsx", { cellStyles: true });
  }

  // Escapes a value for CSV: wraps in quotes (doubling internal quotes) whenever
  // it contains a comma, quote, or newline.
  function csvEscape(value) {
    const str = value === undefined || value === null ? "" : String(value);
    if (/[",\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function exportRowsToCsv(rows) {
    const outputRows = mapRowsToColumns(rows, CSV_EXPORT_COLUMNS);
    const lines = [CSV_EXPORT_COLUMNS.map(csvEscape).join(",")];
    outputRows.forEach(function (row) {
      lines.push(CSV_EXPORT_COLUMNS.map(function (col) { return csvEscape(row[col]); }).join(","));
    });
    // Prefix a UTF-8 BOM so Excel opens the file with correct encoding.
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "TestCases_" + dateStr + ".csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
  const MSG_KEY_PREFIX = "tcgen_msgs_";

  function loadLocalMessages(sessionId) {
    try {
      return JSON.parse(localStorage.getItem(MSG_KEY_PREFIX + sessionId) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveLocalMessage(sessionId, role, text) {
    var msgs = loadLocalMessages(sessionId);
    msgs.push({ role: role, text: text });
    localStorage.setItem(MSG_KEY_PREFIX + sessionId, JSON.stringify(msgs));
  }

  function deleteLocalMessages(sessionId) {
    localStorage.removeItem(MSG_KEY_PREFIX + sessionId);
  }

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
    const sessionDay = new Date(isoString);
    sessionDay.setHours(0, 0, 0, 0);
    const diffDays = Math.round((todayStart - sessionDay) / 86400000);
    if (diffDays <= 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays <= 7) return "Previous 7 Days";
    if (diffDays <= 30) return "Previous 30 Days";
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

    elements.chatMessages.innerHTML = "";
    setExportState(false);

    // Load from localStorage first — instant, no network request needed.
    const localMsgs = loadLocalMessages(sessionId);
    if (localMsgs.length > 0) {
      state.sessionId = sessionId;
      state.lastRequest = null;
      clearAttachedFile();
      updateStatusBar(null);
      localMsgs.forEach(function (msg) {
        if (msg.role === "user") {
          appendUserMessage(msg.text);
        } else {
          appendAssistantMessage(msg.text);
        }
      });
      renderSidebar();
      return;
    }

    // Fall back to Langflow's monitor API.
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

    // Remove local messages and session registry entry.
    deleteLocalMessages(sessionId);
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
    elements.chatInput.placeholder = "I\u2019m " + ASSISTANT_NAME + " \u2014 type your user story here";
    renderEmptyState();
    renderSidebar();
  }

  init();
})();
