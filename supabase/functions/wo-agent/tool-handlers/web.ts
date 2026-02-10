// wo-agent/tool-handlers/web.ts
// Web tools: fetch content from URLs

import type { ToolContext, ToolResult } from "../tools.ts";

/**
 * Fetch content from a URL and return text/markdown.
 * Useful for reading documentation, API specs, or external resources.
 */
export async function handleWebFetch(
  input: Record<string, any>,
  _ctx: ToolContext
): Promise<ToolResult> {
  const { url } = input;
  if (!url) {
    return { success: false, error: "Missing required parameter: url" };
  }

  // Basic URL validation
  try {
    new URL(url);
  } catch {
    return { success: false, error: `Invalid URL: ${url}` };
  }

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Endgame-WO-Agent",
        "Accept": "text/html,text/plain,text/markdown,application/json,*/*",
      },
      // Timeout after 10 seconds
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
    }

    const contentType = resp.headers.get("content-type") || "";
    let content = await resp.text();

    // Limit content size to 20k chars
    if (content.length > 20000) {
      content = content.slice(0, 20000) + "\n...(limited to 20000 chars)";
    }

    return {
      success: true,
      data: {
        url: url,
        content: content,
        content_type: contentType,
        size: content.length,
      },
    };
  } catch (e: any) {
    if (e.name === "TimeoutError") {
      return { success: false, error: "Request timed out after 10 seconds" };
    }
    return { success: false, error: `web_fetch exception: ${e.message}` };
  }
}
