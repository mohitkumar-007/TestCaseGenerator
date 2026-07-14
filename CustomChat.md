# Build Prompt — Test Case Generator Web App (Custom UI + Langflow API)

[PERSONA]
Act as a Senior Frontend Developer building a polished, production-quality
internal tool. Prioritize clean architecture, graceful error handling, and a
professional UI. Vanilla HTML + CSS + JS only — no frameworks, no build step.

[GOAL]
A single-page "Test Case Generator" web app with a custom chat interface that
calls the Langflow REST API directly. It must support TWO input modes:
  (1) typing any user story into the chat, and
  (2) attaching a PRD file (PDF) that overrides the flow's default file,
so the same Langflow flow generates test cases for ANY story or PRD.

[HARD CONSTRAINTS]
1. DO NOT use the Langflow embedded-chat CDN
   (langflow-embedded-chat bundle.min.js). The chat UI is fully custom.
2. All configuration lives in a separate `config.js` — NOTHING hardcoded in
   the HTML or main script:
     const CONFIG = {
       BASE_URL: "http://localhost:7860",
       FLOW_ID: "d5ec4dde-8b3e-414b-87cd-87f8687a054b",
       API_KEY: "",              // injected here only
       MODEL_TWEAKS: {           // optional per-run component overrides
         // e.g. "GoogleGenerativeAIModel-xxxxx": { "model_name": "gemini-3-flash-preview" }
       },
       FILE_COMPONENT_ID: ""     // e.g. "File-AbC12" — the flow's File component
     };
   Include a `config.example.js` with placeholders and add config.js to
   .gitignore guidance in a README comment.
3. API contract:
   - Text run: POST {BASE_URL}/api/v1/run/{FLOW_ID}
     Headers: Content-Type: application/json, x-api-key: {API_KEY}
     Body: { "output_type": "chat", "input_type": "chat",
             "input_value": "<user story text>", "tweaks": {...MODEL_TWEAKS} }
   - File mode (two steps):
     a. Upload: POST {BASE_URL}/api/v2/files (multipart/form-data, field
        "file"), header x-api-key. Read the returned file path from the
        response.
     b. Run: same run endpoint, with tweaks that point the flow's File
        component to the uploaded path:
        tweaks: { [CONFIG.FILE_COMPONENT_ID]: { "path": "<uploaded path>" },
                  ...MODEL_TWEAKS }
     If the upload endpoint returns 404 (older Langflow), fall back to
     POST {BASE_URL}/api/v1/files/upload/{FLOW_ID} and adapt the path parsing.
   - Response parsing: extract the message text defensively from
     data.outputs[0].outputs[0].results.message.text (fall back to
     .artifacts.message or a JSON stringify of outputs if absent). Never
     crash on shape changes — show a friendly parse error instead.
   - Maintain a session_id (generate once per page load, include in the run
     body) so multi-turn context is preserved.

[UI REQUIREMENTS]
4. Header: app title "Test Case Generator", one-line description of what the
   tool does (paste PRD/user story → structured, execution-ready test cases),
   and the assistant name.
5. Chat interface, always open (not a floating bubble):
   - Assistant name: "TestPilot" (suggested — "Siri" is an Apple trademark;
     make the name a single constant so it is trivial to change back)
   - Welcome message: "Happy to help you in Testcase generation"
   - Input placeholder: "I'm TestPilot — type your user story here"
   - User and assistant message bubbles, timestamps, auto-scroll
   - Typing/loading indicator with animated dots while the API call runs
   - Render assistant responses as rich Markdown: tables must render as real
     HTML tables (write a small Markdown-table parser; no external framework)
   - Errors shown in red inside the chat, with the HTTP status and a Retry
     button that re-sends the last request
   - Multiline input (Shift+Enter = newline, Enter = send)
6. File attach:
   - A paperclip/browse button next to the input AND drag-and-drop onto the
     chat area
   - Accept .pdf (primary); show selected filename as a removable chip
   - On send with a file attached: run the two-step file flow; the chat shows
     "Analyzing <filename>..." as the user message
7. Sample user stories: three clickable cards (Banking: fund transfer,
   Insurance: policy claim submission, Finance: loan EMI calculation) —
   clicking one fills the chat input so the user can edit before sending.
8. Dark/Light mode toggle:
   - CSS custom properties for all colors; smooth transition
   - Persist choice in localStorage; default to system preference
     (prefers-color-scheme)
9. Toolbar actions (icon buttons with tooltips):
   - Clear chat (confirm dialog; also resets session_id)
   - Copy: per-assistant-message copy button (copies raw markdown) AND a
     "Copy all test cases" toolbar button
   - Export to Excel: parse the LAST assistant response's markdown table(s)
     and export via SheetJS (xlsx CDN is allowed — the ban is only on the
     Langflow chat CDN) as TestCases_<date>.xlsx with columns exactly:
     TC ID | Description | Steps | Priority | Expected Result
     Map source columns by header name, not position, so column-order
     changes in the model output do not break export. If no table is found,
     show a red error toast: "No test case table found to export."
   - Export disabled (greyed) until at least one table exists.
10. Status bar: small footer showing connection target (BASE_URL), model
    override if set, and last response time in seconds.

[QUALITY & POLISH — the extras]
11. Responsive layout (usable at 1280px desktop down to 768px tablet).
12. Keyboard accessible: focus states, aria-labels on icon buttons.
13. Empty-state design: before first message, show the welcome + sample
    cards elegantly centered.
14. Graceful CORS guidance: if fetch fails with a network/CORS error, the
    red error message must say "Could not reach Langflow at <BASE_URL>.
    Check that Langflow is running and CORS/serving setup (serve this page
    via http://, not file://)."
15. No inline styles; one styles.css. Clean separation: index.html,
    styles.css, config.js, app.js. Comment the API functions thoroughly.
16. Subtle animations only (message fade-in, theme transition) — this is a
    professional QA tool, not a toy.

[OUTPUT]
Produce the complete project: index.html, styles.css, config.example.js,
app.js — full code, no placeholders like "// rest of the logic here". After
the code, add a short README section: how to configure config.js, how to
find FILE_COMPONENT_ID in Langflow (click the File component, copy its ID),
and how to serve the page (python3 -m http.server 8000 — never open via
file://).


CONVERSATION HISTORY SIDEBAR:
- Left collapsible sidebar listing past conversations, grouped by
  lastUsedAt: Today / Yesterday / Previous 7 Days / Previous 30 Days /
  Over 30 days
- "+ New Chat" button at top: generates a fresh session_id, clears the
  chat area, adds a new entry to the registry
- Session registry persisted in localStorage ("tcgen_sessions"):
  [{ id, title, createdAt, lastUsedAt }] — title = first user message or
  attached PRD filename, truncated to 40 chars; update lastUsedAt on
  every message
- Clicking a conversation: fetch its messages via
  GET {BASE_URL}/api/v1/monitor/messages?flow_id={FLOW_ID}&session_id={id}
  (header x-api-key), render them in the chat area (user/assistant
  bubbles from sender field), and set it as the active session so new
  messages continue that conversation
- Hover on a conversation shows a delete icon: confirm dialog, then
  DELETE the session's messages via the monitor API and remove from
  localStorage
- Active conversation highlighted; sidebar collapsible for small screens
- If the monitor API path differs (Langflow version), consult
  {BASE_URL}/docs and adapt


JIRA CONNECTOR:
- A "Jira" tool button sits in the composer toolbar next to "+ File",
  toggled active/inactive like a mode switch. Clicking it opens a panel
  above the composer with two views: Fetch view and Imported view.
- Fetch view: a single-line input ("Enter Jira ID e.g. PROJ-1234") plus a
  "Fetch" button, and a hint line ("Pulls Summary, Description & Acceptance
  Criteria from the ticket to seed generation."). Enter key in the input
  triggers Fetch. A "Close" button (top-right) hides the whole panel and
  clears any in-progress ticket.
- Fetch button behavior: GET `/api/jira/{ticketId}` — same-origin, served
  by this project's own Express backend (`server.js`), NOT Langflow. That
  backend holds the real Jira credentials (`JIRA_BASE_URL`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN` in `.env`, never sent to the browser) and calls Jira
  Cloud's REST API directly: `GET {JIRA_BASE_URL}/rest/api/3/issue/{id}
  ?fields=summary,description,{JIRA_AC_FIELD_ID}` with HTTP Basic auth
  (`email:api_token`, base64). The backend normalizes Jira's response
  (description and rich-text custom fields come back as Atlassian
  Document Format JSON trees, not plain strings — walk the ADF node tree
  to flatten to text; multi-select/object fields reduce to their `.value`)
  and returns clean JSON: `{ id, summary, description, acceptanceCriteria
  }`. The frontend just renders that JSON directly into the three fields —
  no client-side parsing/regex needed. While fetching, disable the button
  and show "Fetching…".
- Acceptance Criteria has no standard Jira field — `JIRA_AC_FIELD_ID` (env
  var on the backend) names the custom field that holds it on this team's
  tickets (e.g. `customfield_10105`, found via `GET {JIRA_BASE_URL}
  /rest/api/3/field`). If unset, the backend returns an empty AC string
  rather than failing the whole fetch.
- Error handling: ticket not found → 404 with a clear message; bad/expired
  API token → 502 pointing at `.env`; Jira unreachable → 502. The frontend
  surfaces the proxy's plain-text error body under the message bubble via
  the same `appendErrorMessage` path used everywhere else.
- On successful fetch, switch to Imported view: header shows
  "✓ Imported <TICKET-ID>" plus "Change ticket" (goes back to Fetch view,
  same panel instance) and "Close". Three editable fields below it —
  SUMMARY (single-line input), DESCRIPTION (textarea), ACCEPTANCE CRITERIA
  (textarea) — pre-filled from the parsed ticket but left editable before
  generation. A "Generate Test Cases →" button sits at the bottom of the
  panel.
- Generate button behavior: read the three (possibly user-edited) field
  values, compose a single `jira_story` text block:
    <TICKET-ID>

    Summary: <summary>

    Description: <description>

    Acceptance Criteria:
    <acceptance>
  Close the Jira panel, then run the MAIN flow (FLOW_ID) with:
    - `input_value`: a short one-line chat message ("Generate test cases
      from imported Jira ticket <TICKET-ID>") — NOT the full story, so the
      chat transcript stays readable, matching the "Analyzing
      <filename>..." pattern used for File mode.
    - `tweaks`: `{ [PREFETCHED_STORY_COMPONENT_ID]: { input_value:
      <jira_story text> } }` merged with MODEL_TWEAKS — the full story is
      injected into a dedicated text-input component in the flow (config
      key `PREFETCHED_STORY_COMPONENT_ID`; auto-discovered from the flow
      definition by node type/id containing "prefetched-story" or
      "text-input" if not pinned in config.js, same auto-resolve pattern
      as `FILE_COMPONENT_ID`).
  Render the response as a normal assistant message (same Markdown/table
  handling, status bar, error+Retry handling as every other send path).
- Config additions: `PREFETCHED_STORY_COMPONENT_ID` (frontend, in
  `config.js` — text-input component ID that receives the composed
  `jira_story` tweak) and, on the backend, `JIRA_BASE_URL` / `JIRA_EMAIL` /
  `JIRA_API_TOKEN` / `JIRA_AC_FIELD_ID` (in `.env`, gitignored, never
  reachable from the browser).
- Architecture:
    [Fetch button] → GET /api/jira/:id (same-origin, Express server.js)
                   → Jira Cloud REST API (Basic auth, server-side token)
                   → { summary, description, acceptanceCriteria } → fields

    [Generate button] → compose jira_story text from the 3 fields
                       → Langflow run (main FLOW_ID), tweak targeting
                         PREFETCHED_STORY_COMPONENT_ID
                       → test cases
  The Express server (`server.js`) also serves the static frontend from
  `public/` on the same port, so there's no CORS to configure and only one
  process to run alongside Langflow.