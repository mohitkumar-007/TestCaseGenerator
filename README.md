# Test Case Generator

A custom chat UI that calls the Langflow REST API directly to turn user
stories or PRD files into structured, execution-ready test cases, with a
Jira Connector that imports a ticket's Summary/Description/Acceptance
Criteria to seed generation.

Frontend: vanilla HTML/CSS/JS, no build step (in `public/`).
Backend: a small Express server (`server.js`) that serves the frontend and
proxies Jira Cloud so the browser never holds a Jira API token.

## Setup

### 1. Install dependencies

```bash
cd /path/to/CustomChatUI
npm install
```

### 2. Configure the frontend

Copy `public/config.example.js` to `public/config.js` and fill in your values:

```js
const CONFIG = {
  BASE_URL: "http://localhost:7860",     // your Langflow server
  FLOW_ID: "your-flow-id",              // from the flow's URL in Langflow
  API_KEY: "your-api-key",              // Langflow API key
  MODEL_TWEAKS: {},                      // optional component overrides
  FILE_COMPONENT_ID: "File-AbC12",      // see step below
  PREFETCHED_STORY_COMPONENT_ID: ""     // see Jira Connector step below
};
```

**Finding `FILE_COMPONENT_ID`:** In Langflow, open your flow, click the
**File** component, and copy its component ID from the component header or
settings panel (e.g. `File-AbC12`).

**Finding `PREFETCHED_STORY_COMPONENT_ID`:** points at a text-input
component in your flow that receives the composed Jira story (Generate
sends it via `tweaks`, not the chat message). Click that component in
Langflow and copy its ID (e.g. `TextInput-xYz89`). If left blank, it's
auto-discovered from the flow definition by matching a node whose type/id
contains "prefetched-story" or "text-input".

`public/config.js` is gitignored — never commit real API keys.

### 3. Configure the Jira proxy

Copy `.env.example` to `.env` and fill in your Jira Cloud details:

```
PORT=8000
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_EMAIL=you@yourcompany.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_AC_FIELD_ID=customfield_10105
```

- Create an API token at
  https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_AC_FIELD_ID` is the custom field holding Acceptance Criteria on your
  tickets (standard Jira has no built-in AC field). Find its ID via
  `GET {JIRA_BASE_URL}/rest/api/3/field` and search the response for its
  display name. Leave blank to skip fetching Acceptance Criteria.

`.env` is gitignored — never commit real Jira credentials.

### 4. Start Langflow

```bash
python -m langflow run
# or: langflow run --host 0.0.0.0 --port 7860
```

### 5. Start the app server

```bash
npm start
```

This serves the frontend AND the `/api/jira/:ticketId` proxy on one port —
no separate static file server, no CORS setup needed. Open
`http://localhost:8000` (or your configured `PORT`) in your browser.

## Features

| Feature | Details |
|---|---|
| Text mode | Type any user story and send |
| File mode | Attach a PDF (paperclip or drag-and-drop) |
| Jira Connector | Fetch Summary/Description/Acceptance Criteria from a Jira ticket ID via the Express proxy, edit them, then generate test cases |
| Markdown rendering | Tables, headers, bold, italic, code blocks |
| Sample stories | Banking, Insurance, Finance cards to fill input |
| Dark / Light mode | Persisted in localStorage; follows system preference |
| Clear chat | Resets session with confirmation |
| Copy message | Per-bubble copy button (raw markdown) |
| Copy all | Copies all assistant responses |
| Export Excel | Parses last table → `TestCases_<date>.xlsx` |
| Status bar | Shows target URL, model override, last response time |
