export interface Snippets {
  claudeCode: string;
  cursor: string;
  env: string;
  curl: string;
}

/** Ready-to-paste client configuration for a freshly issued key. Plain text; the key appears once in each. */
export function buildSnippets(key: string, baseUrl: string): Snippets {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    claudeCode: `claude mcp add --transport http agent-court ${base}/mcp \\\n  --header "Authorization: Bearer ${key}"`,
    cursor: JSON.stringify(
      {
        mcpServers: {
          "agent-court": { url: `${base}/mcp`, headers: { Authorization: `Bearer ${key}` } },
        },
      },
      null,
      2,
    ),
    env: `AGENT_COURT_URL=${base}\nAGENT_COURT_API_KEY=${key}`,
    curl: `curl -H "Authorization: Bearer ${key}" ${base}/api/v1/me`,
  };
}
