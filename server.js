/* ==========================================================================
   server.js — static file server + Jira fetch proxy.
   Serves the frontend from public/ and exposes GET /api/jira/:ticketId,
   which calls Jira Cloud's REST API server-side so the Jira API token
   never reaches the browser and the frontend never talks to Jira directly.
   ========================================================================== */

require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8000;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";
const JIRA_AC_FIELD_ID = process.env.JIRA_AC_FIELD_ID || "";

app.use(express.static(path.join(__dirname, "public")));

// ---- Atlassian Document Format (ADF) -> plain text -------------------------
// Jira Cloud's REST API v3 returns rich-text fields (description, and any
// rich-text custom field) as an ADF node tree instead of a plain string.
function adfToText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;

  const children = Array.isArray(node.content)
    ? node.content.map(adfToText).join("")
    : "";

  switch (node.type) {
    case "text":
      return node.text || "";
    case "paragraph":
    case "heading":
      return children + "\n";
    case "hardBreak":
      return "\n";
    case "listItem":
      return "- " + children.trim() + "\n";
    case "doc":
      return children.trim();
    default:
      return children;
  }
}

// Jira fields can come back as a plain string, an ADF doc, a single-select
// object ({ value: "..." }), or an array of any of those (multi-select /
// checkboxes). Normalize whatever shows up to plain text.
function fieldToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(fieldToText).filter(Boolean).join("\n");
  if (value.type === "doc") return adfToText(value);
  if (typeof value.value === "string") return value.value;
  return "";
}

app.get("/api/jira/:ticketId", async (req, res) => {
  const ticketId = req.params.ticketId.trim();
  if (!ticketId) return res.status(400).send("Missing Jira ticket ID.");

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(500).send(
      "Jira proxy is not configured. Copy .env.example to .env and fill in " +
      "JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN."
    );
  }

  const fields = ["summary", "description"];
  if (JIRA_AC_FIELD_ID) fields.push(JIRA_AC_FIELD_ID);

  const url =
    JIRA_BASE_URL.replace(/\/$/, "") +
    "/rest/api/3/issue/" + encodeURIComponent(ticketId) +
    "?fields=" + fields.join(",");

  const auth = Buffer.from(JIRA_EMAIL + ":" + JIRA_API_TOKEN).toString("base64");

  let jiraRes;
  try {
    jiraRes = await fetch(url, {
      headers: { Authorization: "Basic " + auth, Accept: "application/json" },
    });
  } catch (e) {
    return res.status(502).send("Could not reach Jira at " + JIRA_BASE_URL + ".");
  }

  if (jiraRes.status === 404) {
    return res.status(404).send("Jira ticket " + ticketId + " not found.");
  }
  if (jiraRes.status === 401 || jiraRes.status === 403) {
    return res.status(502).send(
      "Jira authentication failed — check JIRA_EMAIL and JIRA_API_TOKEN in .env."
    );
  }
  if (!jiraRes.ok) {
    const detail = await jiraRes.text().catch(function () { return ""; });
    return res.status(502).send("Jira API error (HTTP " + jiraRes.status + "): " + detail);
  }

  const issue = await jiraRes.json();
  const issueFields = issue.fields || {};

  res.json({
    id: issue.key || ticketId,
    summary: fieldToText(issueFields.summary),
    description: fieldToText(issueFields.description),
    acceptanceCriteria: JIRA_AC_FIELD_ID ? fieldToText(issueFields[JIRA_AC_FIELD_ID]) : "",
  });
});

app.listen(PORT, function () {
  console.log("Test Case Generator running at http://localhost:" + PORT);
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.warn("Jira proxy not configured — copy .env.example to .env and fill in Jira credentials.");
  }
});
