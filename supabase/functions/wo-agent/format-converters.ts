// format-converters.ts
// WO-0551: Format conversion utilities for OpenRouter/OpenAI compatibility
// Converts between Anthropic and OpenAI tool/message formats

import type { Tool } from "npm:@anthropic-ai/sdk@0.39.0/resources/messages.mjs";

/**
 * Convert Anthropic tool definitions to OpenAI function calling format
 */
export function anthropicToolsToOpenAI(anthropicTools: Tool[]): any[] {
  return anthropicTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema, // Anthropic input_schema = OpenAI parameters
    },
  }));
}

/**
 * Convert Anthropic message format to OpenAI message format
 * Handles content blocks, system prompts, tool results
 */
export function anthropicMessagesToOpenAI(
  anthropicMessages: Array<{ role: string; content: any }>,
  systemPrompt?: string
): any[] {
  const openAIMessages: any[] = [];

  // Add system prompt as first message if provided
  if (systemPrompt) {
    openAIMessages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  for (const msg of anthropicMessages) {
    if (msg.role === "assistant") {
      // Assistant message may have text + tool_use blocks
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((b: any) => b.type === "text");
        const toolUseBlocks = msg.content.filter((b: any) => b.type === "tool_use");

        const textContent = textBlocks.map((b: any) => b.text).join("\n") || null;
        
        if (toolUseBlocks.length > 0) {
          // Convert tool_use blocks to tool_calls
          openAIMessages.push({
            role: "assistant",
            content: textContent,
            tool_calls: toolUseBlocks.map((block: any) => ({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })),
          });
        } else {
          // Plain text message
          openAIMessages.push({
            role: "assistant",
            content: textContent || "",
          });
        }
      } else {
        // String content
        openAIMessages.push({
          role: "assistant",
          content: msg.content,
        });
      }
    } else if (msg.role === "user") {
      // User message may have text + tool_result blocks
      if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((b: any) => b.type === "text");
        const toolResultBlocks = msg.content.filter((b: any) => b.type === "tool_result");

        if (toolResultBlocks.length > 0) {
          // Convert tool_result blocks to tool messages
          for (const block of toolResultBlocks) {
            openAIMessages.push({
              role: "tool",
              tool_call_id: block.tool_use_id,
              content: block.content,
            });
          }
        } else {
          // Plain text user message
          const textContent = textBlocks.length > 0
            ? textBlocks.map((b: any) => b.text).join("\n")
            : (typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
          
          openAIMessages.push({
            role: "user",
            content: textContent,
          });
        }
      } else {
        // String content
        openAIMessages.push({
          role: "user",
          content: msg.content,
        });
      }
    }
  }

  return openAIMessages;
}

/**
 * Convert OpenAI response format back to Anthropic format
 * This maintains backward compatibility with existing code
 */
export function openAIResponseToAnthropic(openAIResponse: any): any {
  const choice = openAIResponse.choices?.[0];
  if (!choice) {
    throw new Error("No choices in OpenAI response");
  }

  const message = choice.message;
  const content: any[] = [];

  // Add text content if present
  if (message.content) {
    content.push({
      type: "text",
      text: message.content,
    });
  }

  // Add tool_use blocks if present
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.function.name,
        input: JSON.parse(toolCall.function.arguments),
      });
    }
  }

  // Map finish_reason to stop_reason
  const stopReasonMap: Record<string, string> = {
    "stop": "end_turn",
    "tool_calls": "tool_use",
    "length": "max_tokens",
  };

  return {
    id: openAIResponse.id,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model: openAIResponse.model,
    stop_reason: stopReasonMap[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: openAIResponse.usage?.prompt_tokens || 0,
      output_tokens: openAIResponse.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

/**
 * Convert tool results from Anthropic format to OpenAI format
 * Used when adding tool results back to the conversation
 */
export function toolResultsToOpenAI(anthropicToolResults: any[]): any[] {
  return anthropicToolResults.map((result) => ({
    role: "tool",
    tool_call_id: result.tool_use_id,
    content: result.content,
  }));
}
