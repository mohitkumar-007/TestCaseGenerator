// Copy this file to config.js and fill in your Langflow details.
// config.js is gitignored — never commit real API keys.
const CONFIG = {
  BASE_URL: "http://localhost:7860",
  FLOW_ID: "your-flow-id",
  API_KEY: "your-api-key",  // injected here only
  MODEL_TWEAKS: {           // optional per-run component overrides
    // e.g. "GoogleGenerativeAIModel-xxxxx": { "model_name": "gemini-3-flash-preview" }
  },
  FILE_COMPONENT_ID: "",              // e.g. "File-AbC12" — the flow's File component
  PREFETCHED_STORY_COMPONENT_ID: ""   // e.g. "TextInput-xYz89" — the flow's text-input
                                       // component that receives the imported Jira story
};
