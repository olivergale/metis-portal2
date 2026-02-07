// portal-chat/index.ts - v44
// v44: WO-0007 - Plan mode build transition triggers project creation
// Changes from v43:
//   - When user says "build it" in plan mode with tech context, immediately trigger project creation
//   - Use plan_topic from thread metadata as project name
//   - Create project_brief, start interrogation, generate docs, decompose into WOs
//   - Full plan→build flow: enter plan mode → discuss → "build it" → project created → docs → WOs

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@0.39.0";
import { Langfuse } from "npm:langfuse@3.32.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface Attachment {
  name: string;
  type: string;
  base64?: string;
  textContent?: string;
}

interface RequestBody {
  message: string;
  thread_id?: string;
  project_code?: string;
  user_id?: string;
  attachments?: Attachment[];
}

async function generateEmbedding(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text, dimensions: 384 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch { return null; }
}

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function formatBugs(bugs: any[]): string {
  if (!bugs.length) return '';
  const lines = bugs.map((b: any) => '- [' + (b.work_order || '?') + '] ' + (b.description || ''));
  return '\n## Open Bugs: ' + bugs.length + '\n' + lines.join('\n') + '\n';
}

// ===== CONVERSATIONAL INTERROGATION HELPERS =====

/** Get or create thread metadata */
async function getThreadMetadata(supabase: any, threadId: string): Promise<Record<string, any>> {
  const { data } = await supabase
    .from('conversation_threads')
    .select('metadata')
    .eq('id', threadId)
    .single();
  return data?.metadata || {};
}

/** Update thread metadata (merge) */
async function updateThreadMetadata(supabase: any, threadId: string, updates: Record<string, any>): Promise<void> {
  const current = await getThreadMetadata(supabase, threadId);
  const merged = { ...current, ...updates };
  await supabase
    .from('conversation_threads')
    .update({ metadata: merged })
    .eq('id', threadId);
}

/** Use LLM to parse natural language answers into structured Q&A pairs */
async function parseAnswersWithLLM(
  anthropic: Anthropic,
  userMessage: string,
  questions: any[],
  domain: string
): Promise<Array<{ question: string; answer: string }>> {
  const questionList = questions.map((q: any, i: number) => `${i + 1}. ${q.question}`).join('\n');

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: `You are a parser that extracts structured answers from natural language responses. Given a set of questions and a user's conversational response, extract the answer for each question. If the user didn't address a question, use "Not specified" as the answer. Return ONLY a JSON array of objects with "question" and "answer" fields. No markdown, no explanation.`,
    messages: [{
      role: "user",
      content: `Questions for the "${domain}" domain:\n${questionList}\n\nUser's response:\n"${userMessage}"\n\nExtract answers as JSON array:`
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]';
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    // Fallback: assign entire message as answer to all questions
    return questions.map((q: any) => ({ question: q.question, answer: userMessage }));
  }
}

/** Format questions conversationally using LLM */
async function formatQuestionsConversationally(
  anthropic: Anthropic,
  questions: any[],
  domain: string,
  projectName: string,
  domainIndex: number,
  totalDomains: number,
  isFirst: boolean
): Promise<string> {
  const questionList = questions.map((q: any, i: number) => `${i + 1}. ${q.question}`).join('\n');

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: `You are METIS, helping a user define their project through natural conversation. Present technical questions in a friendly, conversational way. Don't number them mechanically — weave them into a natural paragraph or two. Keep it concise. Don't repeat the project name excessively. Don't use emojis.`,
    messages: [{
      role: "user",
      content: `Project: "${projectName}"\nDomain: ${domain} (${domainIndex + 1} of ${totalDomains})\n${isFirst ? 'This is the first set of questions.' : 'The user has already answered previous domains.'}\n\nQuestions to present conversationally:\n${questionList}`
    }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : questionList;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const loadTimestamp = new Date().toISOString();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;
  const openaiKey = Deno.env.get("OPENAI_API_KEY")!;
  const langfusePublicKey = Deno.env.get("LANGFUSE_PUBLIC_KEY");
  const langfuseSecretKey = Deno.env.get("LANGFUSE_SECRET_KEY");

  const supabase = createClient(supabaseUrl, supabaseKey);
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  let langfuse: Langfuse | null = null;
  let trace: any = null;
  if (langfusePublicKey && langfuseSecretKey) {
    langfuse = new Langfuse({ publicKey: langfusePublicKey, secretKey: langfuseSecretKey, baseUrl: "https://us.cloud.langfuse.com" });
  }

  let chatTraceId: string | null = null;
  let llmSpanId: string | null = null;

  try {
    const body: RequestBody = await req.json();
    const { message, project_code = "METIS-001", user_id = "default", attachments = [] } = body;
    let { thread_id } = body;

    if (!message?.trim()) {
      return respond({ error: "Message required" }, 400);
    }

    if (!thread_id) {
      const { data: newThread, error: threadError } = await supabase
        .from("conversation_threads").insert({ user_id, title: message.slice(0, 100) }).select("id").single();
      if (threadError) throw new Error(`Thread creation failed: ${threadError.message}`);
      thread_id = newThread.id;
    }

    chatTraceId = `chat-${thread_id}-${Date.now()}`;
    try {
      await supabase.from('traces').insert({
        trace_id: chatTraceId,
        name: `Portal Chat: ${message.slice(0, 50)}...`,
        user_id: user_id,
        session_id: 'portal-chat',
        thread_id: thread_id,
        input: { message: message.slice(0, 500), project_code },
        metadata: { version: 'v44' },
        status: 'running'
      });
    } catch (traceErr) {
      console.error('[TRACE] Failed to create trace:', traceErr);
    }

    if (langfuse) {
      trace = langfuse.trace({ id: chatTraceId!, name: "portal-chat", sessionId: thread_id, userId: user_id, input: { message, project_code }, tags: ["metis", "v44"] });
    }

    const msgLower = message.toLowerCase().trim();

    // ===== CHECK FOR ACTIVE INTERROGATION ON THIS THREAD =====
    const threadMeta = await getThreadMetadata(supabase, thread_id);
    const activeInterrogation = threadMeta.interrogation_session_id && threadMeta.interrogation_active;

    if (activeInterrogation) {
      // User is in conversational interrogation — parse their answer
      const sessionId = threadMeta.interrogation_session_id;
      const currentDomain = threadMeta.current_domain;
      const projectBriefId = threadMeta.project_brief_id;
      const projectName = threadMeta.project_name || 'Unknown Project';

      try {
        // Get current interrogation status
        const { data: status } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });
        if (!status || status.error) throw new Error(status?.error || 'Session not found');

        const questions = status.next_questions || [];
        const domain = currentDomain || status.next_domain;

        // Parse natural language into structured answers
        const parsedAnswers = await parseAnswersWithLLM(anthropic, message, questions, domain);

        // Submit answers
        const { data: result, error: ansErr } = await supabase.rpc('submit_interrogation_answer', {
          p_session_id: sessionId,
          p_domain: domain,
          p_answers: parsedAnswers
        });
        if (ansErr) throw ansErr;
        if (result?.error) throw new Error(result.error);

        // Check what's next
        const { data: newStatus } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });

        if (result.all_answered) {
          // All domains complete — auto-generate docs
          await updateThreadMetadata(supabase, thread_id, {
            interrogation_active: false,
            current_domain: null,
            phase: 'generating_docs'
          });

          const progressMsg = `Great, I have everything I need for **${projectName}**. Generating project documentation now...`;
          await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: progressMsg });

          // Call generate-docs
          let genResult: any = null;
          try {
            const genResponse = await fetch(supabaseUrl + '/functions/v1/generate-docs/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + supabaseKey },
              body: JSON.stringify({ session_id: sessionId }),
            });
            genResult = await genResponse.json();
          } catch (genErr: any) {
            console.error('[DOC-GEN] Failed:', genErr);
          }

          let responseMsg: string;
          if (genResult && genResult.docs_generated > 0) {
            // Docs generated — trigger decomposition
            await updateThreadMetadata(supabase, thread_id, { phase: 'decomposing' });

            let decompResult: any = null;
            try {
              const decompResponse = await fetch(supabaseUrl + '/functions/v1/decompose-project', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + supabaseKey },
                body: JSON.stringify({ project_brief_id: projectBriefId }),
              });
              decompResult = await decompResponse.json();
            } catch (decompErr: any) {
              console.error('[DECOMPOSE] Failed:', decompErr);
            }

            if (decompResult && decompResult.work_orders_created > 0) {
              responseMsg = `**Project setup complete for ${projectName}.**\n\n` +
                `**Documentation** (${genResult.docs_generated} docs generated):\n` +
                genResult.results.map((r: any) => `- ${r.doc_type}: ${r.status}`).join('\n') + '\n\n' +
                `**Work Orders** (${decompResult.work_orders_created} created):\n` +
                (decompResult.work_orders || []).map((wo: any) => `- \`${wo.slug}\`: ${wo.name}`).join('\n') + '\n\n' +
                `All work orders are in **draft** status and require approval. Review and approve them in the Workspace to start building.`;
            } else {
              responseMsg = `**Documentation generated for ${projectName}** (${genResult.docs_generated} docs).\n\n` +
                genResult.results.map((r: any) => `- ${r.doc_type}: ${r.status}`).join('\n') + '\n\n' +
                (decompResult?.error ? `Work order decomposition encountered an issue: ${decompResult.error}. You can retry or create work orders manually.` : 'Work order decomposition will be available once the decompose-project function is deployed.');
            }

            await updateThreadMetadata(supabase, thread_id, { phase: 'complete' });
          } else {
            responseMsg = `I recorded all your answers for **${projectName}**, but doc generation had an issue` +
              (genResult?.error ? `: ${genResult.error}` : '.') +
              ` You can retry with \`/generate-docs ${sessionId}\`.`;
            await updateThreadMetadata(supabase, thread_id, { phase: 'docs_failed' });
          }

          await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });

          try {
            await supabase.from('traces').update({
              status: 'completed', ended_at: new Date().toISOString(),
              output: { conversational_intake: true, phase: 'complete', docs_generated: genResult?.docs_generated },
              metadata: { version: 'v44', conversational_intake: true }
            }).eq('trace_id', chatTraceId);
          } catch (_) {}

          if (langfuse) await langfuse.flushAsync();

          return respond({
            thread_id, message: responseMsg,
            context: { project_name: projectName, phase: 'complete', docs_generated: genResult?.docs_generated, trace_id: chatTraceId }
          });

        } else {
          // More domains to go — present next questions conversationally
          const nextDomain = newStatus?.next_domain;
          const nextQuestions = newStatus?.next_questions || [];
          const allDomains = newStatus?.all_domains || [];
          const completedDomains = newStatus?.domains_completed || [];
          const domainIndex = allDomains.indexOf(nextDomain);

          const conversationalQuestions = await formatQuestionsConversationally(
            anthropic, nextQuestions, nextDomain, projectName,
            domainIndex >= 0 ? domainIndex : completedDomains.length,
            allDomains.length, false
          );

          const progressPct = newStatus?.progress_pct || 0;
          const responseMsg = `Got it, thanks. (${progressPct}% complete)\n\nNext up — **${nextDomain}**:\n\n${conversationalQuestions}`;

          await updateThreadMetadata(supabase, thread_id, { current_domain: nextDomain });
          await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });

          try {
            await supabase.from('traces').update({
              status: 'completed', ended_at: new Date().toISOString(),
              output: { conversational_intake: true, domain_completed: domain, next_domain: nextDomain, progress_pct: progressPct },
              metadata: { version: 'v44', conversational_intake: true }
            }).eq('trace_id', chatTraceId);
          } catch (_) {}

          if (langfuse) await langfuse.flushAsync();

          return respond({
            thread_id, message: responseMsg,
            interrogation_progress: { completed_domain: domain, next_domain: nextDomain, progress_pct: progressPct },
            context: { project_name: projectName, trace_id: chatTraceId }
          });
        }
      } catch (intErr: any) {
        console.error('[CONVERSATIONAL-INTERROGATION] Error:', intErr);
        // Clear interrogation state on error so user isn't stuck
        await updateThreadMetadata(supabase, thread_id, { interrogation_active: false });
        // Fall through to normal chat
      }
    }

    // ===== EXIT PLAN MODE DETECTION =====
    const exitPlanPhrases = ["cancel planning", "stop planning", "exit plan mode", "cancel plan mode", "stop plan mode", "leave plan mode", "quit planning", "/exit-plan", "exit plan"];
    const isExitPlanRequest = exitPlanPhrases.some(p => msgLower.includes(p));
    let isInPlanMode = threadMeta.plan_mode === true;

    if (isInPlanMode && isExitPlanRequest) {
      // Exit plan mode
      const exitMethod = msgLower.includes('/exit-plan') ? 'command' : 'natural_language';
      await updateThreadMetadata(supabase, thread_id, {
        plan_mode: false,
        plan_exited: true,
        plan_exited_at: new Date().toISOString(),
        plan_exit_method: exitMethod,
        plan_exit_message: message
      });
      isInPlanMode = false;

      const exitMsg = `Plan mode exited. We can continue with a regular conversation, or you can:\n\n- Say "build it" or "let's build this" when you're ready to create work orders\n- Ask questions about the system or status\n- Start planning something else with "let's plan" or "/plan"`;

      await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
      await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: exitMsg });

      try {
        await supabase.from('traces').update({
          status: 'completed',
          ended_at: new Date().toISOString(),
          output: { plan_mode_exited: true, exit_method: exitMethod },
          metadata: { version: 'v44', command: 'exit-plan' }
        }).eq('trace_id', chatTraceId);
      } catch (_) {}

      if (langfuse) await langfuse.flushAsync();

      return respond({
        thread_id,
        message: exitMsg,
        plan_mode_exited: true,
        exit_method: exitMethod,
        context: {
          plan_mode: false,
          was_in_plan_mode: true,
          trace_id: chatTraceId
        }
      });
    }

    // ===== PLAN MODE DETECTION =====
    const planPhrases = ["let's plan", "help me plan", "plan out", "scope out", "what would it take", "how should we approach", "think about building", "explore options", "design approach", "/plan", "enter plan mode", "planning mode"];
    const isPlanRequest = planPhrases.some(p => msgLower.includes(p));
    const buildTransitionPhrases = ["build it", "let's build this", "start building", "approve the plan", "ready to build", "go ahead and build", "make it happen", "execute the plan", "ship it", "/build", "let's do it"];
    const isBuildTransition = buildTransitionPhrases.some(p => msgLower.includes(p));

    // ===== WO-0007: Plan mode build transition with tech context =====
    const techNouns = ["function", "endpoint", "api", "table", "schema", "component", "feature", "service", "webhook", "integration", "app", "application", "website", "site", "platform", "tool", "dashboard", "system", "project", "bot", "backend", "frontend", "database", "ui", "interface"];
    const hasTechNoun = techNouns.some(n => msgLower.includes(n));

    if (isInPlanMode && isBuildTransition) {
      // User wants to transition from plan → build
      await updateThreadMetadata(supabase, thread_id, {
        plan_mode: false,
        plan_transitioned_to_build: true,
        plan_ended_at: new Date().toISOString()
      });
      isInPlanMode = false;

      // GUARD: Check if message is too vague (no tech nouns)
      if (!hasTechNoun) {
        // Incomplete build intent — exit plan mode but ask for clarification
        await updateThreadMetadata(supabase, thread_id, {
          partial_build_intent: true,
          partial_build_message: message,
          partial_build_timestamp: new Date().toISOString()
        });

        const clarificationMsg = `I'd be happy to build this. Could you specify what component or feature you'd like me to start with? For example:\n\n- A specific API endpoint\n- A database table or schema\n- A UI component\n- An integration with an external service\n- Or describe the first piece to implement`;

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: clarificationMsg });

        try {
          await supabase.from('traces').update({
            status: 'completed',
            ended_at: new Date().toISOString(),
            output: { incomplete_build_transition: true, clarification_requested: true },
            metadata: { version: 'v44', guard: 'incomplete_build_transition' }
          }).eq('trace_id', chatTraceId);
        } catch (_) {}

        if (langfuse) await langfuse.flushAsync();

        return respond({
          thread_id,
          message: clarificationMsg,
          incomplete_build_transition: true,
          context: {
            plan_mode_exited: true,
            awaiting_specification: true,
            trace_id: chatTraceId
          }
        });
      }

      // WO-0007 FIX: Has tech nouns — trigger project creation immediately
      try {
        // Extract project name from plan_topic in thread metadata
        const projectName = (threadMeta.plan_topic || message).slice(0, 100);
        const projectCode = 'PROJ-' + Date.now().toString(36).toUpperCase();

        // Create project_brief
        const { data: newProject, error: projErr } = await supabase
          .from('project_briefs')
          .insert({
            code: projectCode,
            name: projectName,
            status: 'intake',
            summary: threadMeta.plan_topic || message,
            created_by: user_id,
            current_phase: 0,
            completion_pct: 0
          })
          .select('id, code, name')
          .single();

        if (projErr) throw projErr;

        // Start interrogation for this project
        const { data: sessionId, error: intError } = await supabase.rpc('start_interrogation', {
          p_trigger_type: 'plan_mode_build_transition',
          p_project_id: newProject.id,
          p_thread_id: thread_id
        });
        if (intError) throw intError;

        // Get first questions
        const { data: intStatus } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });
        const firstDomain = intStatus?.next_domain || 'core';
        const firstQuestions = intStatus?.next_questions || [];
        const allDomains = intStatus?.all_domains || [];

        // Store interrogation state in thread metadata
        await updateThreadMetadata(supabase, thread_id, {
          interrogation_session_id: sessionId,
          project_brief_id: newProject.id,
          project_code: projectCode,
          project_name: projectName,
          current_domain: firstDomain,
          interrogation_active: true,
          phase: 'interrogating',
          plan_converted_to_project: true
        });

        // Format first questions conversationally
        const conversationalQuestions = await formatQuestionsConversationally(
          anthropic, firstQuestions, firstDomain, projectName,
          0, allDomains.length, true
        );

        const responseMsg = `Perfect! I've created project **${projectName}** (\`${projectCode}\`) based on your planning discussion. Before I build it, I need to understand a few implementation details.\n\n${conversationalQuestions}`;

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });

        try {
          await supabase.from('traces').update({
            status: 'completed', ended_at: new Date().toISOString(),
            output: { plan_build_transition: true, project_code: projectCode, session_id: sessionId },
            metadata: { version: 'v44', feature: 'plan_build_transition' }
          }).eq('trace_id', chatTraceId);
        } catch (_) {}

        if (langfuse) await langfuse.flushAsync();

        return respond({
          thread_id, message: responseMsg,
          project: { code: projectCode, name: projectName, id: newProject.id },
          interrogation_session_id: sessionId,
          context: { plan_build_transition: true, project_code: projectCode, trace_id: chatTraceId }
        });
      } catch (buildTransErr: any) {
        console.error('[PLAN-BUILD-TRANSITION] Failed:', buildTransErr);
        // Fall back to clarification message
        const fallbackMsg = `I'd like to build this, but encountered an issue creating the project. Could you describe what you'd like to build in more detail?`;
        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: fallbackMsg });
        return respond({ thread_id, message: fallbackMsg, error: buildTransErr.message });
      }
    } else if (isPlanRequest && !isInPlanMode) {
      // ===== ENTER PLAN MODE =====
      await updateThreadMetadata(supabase, thread_id, {
        plan_mode: true,
        plan_started_at: new Date().toISOString(),
        plan_topic: message.slice(0, 200)
      });
      isInPlanMode = true;

      // Send explicit confirmation message
      const planModeConfirmation = `**Entered plan mode.** I'll help you explore and scope this idea through conversation.\n\nIn plan mode, I can:\n- Ask clarifying questions to understand your requirements\n- Suggest architecture patterns and technology choices\n- Discuss trade-offs and estimate complexity\n- Help you refine the approach before committing\n\nWhen you're ready to implement, say **"build it"** or **"let's build this"** to transition to build mode and create work orders.\n\nYou can also exit plan mode anytime by saying **"cancel planning"** or **/exit-plan**.\n\n---\n\nLet's explore your idea. What are you thinking about building?`;

      await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
      await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: planModeConfirmation });

      try {
        await supabase.from('traces').update({
          status: 'completed',
          ended_at: new Date().toISOString(),
          output: { plan_mode_entered: true, confirmation_sent: true },
          metadata: { version: 'v44', feature: 'plan_mode_confirmation' }
        }).eq('trace_id', chatTraceId);
      } catch (_) {}

      if (langfuse) await langfuse.flushAsync();

      return respond({
        thread_id,
        message: planModeConfirmation,
        plan_mode_entered: true,
        context: {
          plan_mode: true,
          plan_topic: message.slice(0, 200),
          confirmation_sent: true,
          trace_id: chatTraceId
        }
      });
    }

    // ===== CHECK FOR PARTIAL BUILD INTENT RESOLUTION =====
    if (threadMeta.partial_build_intent && hasTechNoun && !isInPlanMode) {
      // User responded to clarification with tech nouns — clear flag and proceed with build
      await updateThreadMetadata(supabase, thread_id, {
        partial_build_intent: false,
        partial_build_resolved: true,
        partial_build_resolved_at: new Date().toISOString()
      });
      // Fall through to build intent detection
    }

    // ===== COMMAND: /summary =====
    if (msgLower.startsWith('/summary')) {
      try {
        const parts = message.trim().split(/\s+/);
        const sinceHours = parts.length > 1 ? parseInt(parts[1]) || 24 : 24;

        const { data: summaryData, error: summaryErr } = await supabase.rpc('get_session_summary', {
          p_project_code: project_code,
          p_since: new Date(Date.now() - sinceHours * 3600000).toISOString()
        });
        if (summaryErr) throw summaryErr;

        const sections: Record<string, any> = {};
        for (const row of (summaryData || [])) {
          sections[row.category] = row.items;
        }

        const h = sections.harness_stats || {};
        const l = sections.lessons || {};
        const m = sections.mutations || {};
        const completed = Array.isArray(sections.completed) ? sections.completed : [];
        const inProgress = Array.isArray(sections.in_progress) ? sections.in_progress : [];
        const blocked = Array.isArray(sections.blocked) ? sections.blocked : [];
        const bugs = Array.isArray(sections.bugs) ? sections.bugs : [];

        const completedList = completed.length
          ? completed.map((w: any) => '- `' + w.slug + '`: ' + w.name).join('\n')
          : '- None';
        const inProgressList = inProgress.length
          ? inProgress.map((w: any) => '- `' + w.slug + '`: ' + w.name + ' (' + (w.assigned_to || 'unassigned') + ')').join('\n')
          : '- None';
        const blockedList = blocked.length
          ? blocked.map((w: any) => '- `' + w.slug + '`: ' + w.name).join('\n')
          : '- None';

        const spanTypes = Object.entries(h.spans_by_type || {}).map(([k,v]) => k + ': ' + v).join(', ');
        const mutTables = Object.entries(m.by_table || {}).map(([k,v]) => k + ': ' + v).join(', ');
        const lessonSev = Object.entries(l.by_severity || {}).map(([k,v]) => k + ': ' + v).join(', ');

        const costStr = '$' + parseFloat(h.total_cost_usd || 0).toFixed(4);
        const avgLatStr = Math.round(h.avg_latency_ms || 0) + 'ms';

        const responseMsg = '**Session Summary** (last ' + sinceHours + 'h)\n\n' +
          '## Work Orders\n' +
          '**Completed:** ' + completed.length + '\n' + completedList + '\n\n' +
          '**In Progress:** ' + inProgress.length + '\n' + inProgressList + '\n\n' +
          '**Blocked:** ' + blocked.length + '\n' + blockedList + '\n\n' +
          '## Observability\n' +
          '| Metric | Value |\n|--------|-------|\n' +
          '| Traces | ' + (h.traces_completed || 0) + '/' + (h.traces_total || 0) + ' completed |\n' +
          '| Spans | ' + (h.spans_completed || 0) + '/' + (h.spans_total || 0) + ' completed (' + (h.spans_running || 0) + ' running) |\n' +
          '| Span types | ' + (spanTypes || 'none') + ' |\n' +
          '| Total tokens | ' + (h.total_tokens || 0) + ' |\n' +
          '| Total cost | ' + costStr + ' |\n' +
          '| Avg latency | ' + avgLatStr + ' |\n' +
          '| Directives | ' + (h.directives_active || 0) + ' active (' + (h.directives_hard || 0) + ' hard) |\n\n' +
          '## Lessons\n' +
          '| Metric | Value |\n|--------|-------|\n' +
          '| Total (period) | ' + (l.total_since || 0) + ' |\n' +
          '| Unreviewed | ' + (l.unreviewed || 0) + ' |\n' +
          '| By severity | ' + (lessonSev || 'none') + ' |\n\n' +
          '## Mutations\n' +
          '| Metric | Value |\n|--------|-------|\n' +
          '| Total | ' + (m.total || 0) + ' |\n' +
          '| By table | ' + (mutTables || 'none') + ' |\n' +
          formatBugs(bugs);

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });

        try {
          await supabase.from('traces').update({
            status: 'completed', ended_at: new Date().toISOString(),
            output: { command: 'summary', sections: Object.keys(sections) },
            metadata: { version: 'v44', command: 'summary' }
          }).eq('trace_id', chatTraceId);
        } catch (_) {}

        if (langfuse) await langfuse.flushAsync();

        return respond({
          thread_id, message: responseMsg,
          summary_data: sections,
          context: { command: 'summary', since_hours: sinceHours, data_loaded_at: loadTimestamp, trace_id: chatTraceId }
        });
      } catch (err: any) {
        return respond({ thread_id, message: 'Summary failed: ' + err.message, error: err.message });
      }
    }

    // ===== COMMAND: /interrogate =====
    if (msgLower.startsWith('/interrogate') && !msgLower.startsWith('/interrogate-answer')) {
      try {
        const parts = message.trim().split(/\s+/);
        const cmdProjectId = parts.length > 1 ? parts[1] : null;

        let projectId = cmdProjectId;
        if (!projectId) {
          const { data: proj } = await supabase
            .from('project_briefs').select('id').eq('code', project_code).single();
          projectId = proj?.id || null;
        }

        const { data: sessionId, error: intError } = await supabase.rpc('start_interrogation', {
          p_trigger_type: 'manual',
          p_project_id: projectId,
          p_thread_id: thread_id
        });
        if (intError) throw intError;

        const { data: status } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });

        const questions = status?.next_questions || [];
        const domain = status?.next_domain || 'unknown';
        const qList = questions.map((q: any, i: number) => (i+1) + '. ' + q.question).join('\n\n');

        const responseMsg = '**Interrogation Session Started**\n\nSession: `' + sessionId + '`\nDomain: **' + domain + '** (1 of ' + (status?.all_domains?.length || 7) + ')\n\n' + qList + '\n\nAnswer using:\n`/interrogate-answer ' + sessionId + ' ' + domain + ' Your answers here`';

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });

        try {
          await supabase.from('traces').update({
            status: 'completed', ended_at: new Date().toISOString(),
            output: { command: 'interrogate', session_id: sessionId },
            metadata: { version: 'v44', command: 'interrogate' }
          }).eq('trace_id', chatTraceId);
        } catch (_) {}

        if (langfuse) await langfuse.flushAsync();

        return respond({
          thread_id, message: responseMsg,
          interrogation_session_id: sessionId, interrogation_status: status,
          context: { command: 'interrogate', data_loaded_at: loadTimestamp }
        });
      } catch (intErr: any) {
        console.error('Interrogation error:', intErr);
        return respond({ thread_id, message: 'Failed to start interrogation: ' + intErr.message, error: intErr.message });
      }
    }

    // ===== COMMAND: /interrogate-answer =====
    if (msgLower.startsWith('/interrogate-answer')) {
      try {
        const parts = message.trim().split(/\s+/);
        if (parts.length < 4) {
          const usage = 'Usage: `/interrogate-answer <session_id> <domain> <your answers>`';
          await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
          await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: usage });
          return respond({ thread_id, message: usage });
        }

        const sessionId = parts[1];
        const domain = parts[2];
        const answerText = parts.slice(3).join(' ');

        const { data: status } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });
        if (status?.error) throw new Error(status.error);

        const domainQuestions = (status?.next_questions || []).filter((_q: any) => true);
        const answers = domainQuestions.map((q: any) => ({ question: q.question, answer: answerText }));

        const { data: result, error: ansErr } = await supabase.rpc('submit_interrogation_answer', {
          p_session_id: sessionId, p_domain: domain, p_answers: answers
        });
        if (ansErr) throw ansErr;
        if (result?.error) throw new Error(result.error);

        const { data: newStatus } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });

        let responseMsg: string;
        if (result.all_answered) {
          responseMsg = '**Domain "' + domain + '" recorded.** All domains complete (' + (newStatus?.progress_pct || 100) + '%).\n\nReady to generate docs. Use:\n`/generate-docs ' + sessionId + '`';
        } else {
          const nextQs = newStatus?.next_questions || [];
          const qList = nextQs.map((q: any, i: number) => (i+1) + '. ' + q.question).join('\n\n');
          responseMsg = '**Domain "' + domain + '" recorded.** Progress: ' + (newStatus?.progress_pct || 0) + '%\n\nNext domain: **' + newStatus?.next_domain + '**\n\n' + qList + '\n\nAnswer using:\n`/interrogate-answer ' + sessionId + ' ' + newStatus?.next_domain + ' Your answers`';
        }

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });
        if (langfuse) await langfuse.flushAsync();

        return respond({ thread_id, message: responseMsg, interrogation_status: newStatus });
      } catch (err: any) {
        return respond({ thread_id, message: 'Answer submission failed: ' + err.message, error: err.message });
      }
    }

    // ===== COMMAND: /generate-docs =====
    if (msgLower.startsWith('/generate-docs')) {
      try {
        const parts = message.trim().split(/\s+/);
        const sessionId = parts[1];
        if (!sessionId) {
          const msg = 'Usage: `/generate-docs <session_id>`';
          await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
          await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: msg });
          return respond({ thread_id, message: msg });
        }

        await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });

        const genResponse = await fetch(supabaseUrl + '/functions/v1/generate-docs/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + supabaseKey },
          body: JSON.stringify({ session_id: sessionId }),
        });
        const genResult = await genResponse.json();

        const resultLines = (genResult.results || []).map((r: any) =>
          '- ' + r.doc_type + ': ' + r.status + ' (' + r.chars + ' chars' + (r.version ? ', v' + r.version : '') + ')'
        ).join('\n');

        const responseMsg = '**Doc Generation Complete**\n\nProject: ' + (genResult.project_name || 'Unknown') + '\nGenerated: ' + (genResult.docs_generated || 0) + '/' + (genResult.results || []).length + '\nFailed: ' + (genResult.docs_failed || 0) + '\n\n' + resultLines;

        await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });
        if (langfuse) await langfuse.flushAsync();

        return respond({ thread_id, message: responseMsg, generation_result: genResult });
      } catch (err: any) {
        return respond({ thread_id, message: 'Doc generation failed: ' + err.message, error: err.message });
      }
    }

    // ===== MAIN CHAT FLOW =====
    const embedding = await generateEmbedding(message, openaiKey);

    const contextPromises: Promise<any>[] = [
      supabase.from("system_directives").select("name, content, enforcement").eq("active", true).order("priority", { ascending: false }).limit(20),
      supabase.from("project_briefs").select("*").eq("code", project_code).single(),
      supabase.from("decisions").select("subject, choice, rationale").eq("status", "active").limit(8),
      supabase.from("thread_messages").select("role, content").eq("thread_id", thread_id).order("created_at", { ascending: true }).limit(30),
      supabase.from("backlog").select("name, priority, status").eq("status", "active").limit(5),
      supabase.from("work_orders").select("id, slug, name, status, priority, assigned_to, approved_at, created_at, source").in("status", ["draft", "ready", "in_progress", "review", "blocked"]).order("created_at", { ascending: false }).limit(10),
      supabase.from("system_status").select("component, status, last_heartbeat, metadata"),
      supabase.from("agents").select("id, name, agent_type, status, description"),
      supabase.from("user_preferences").select("key, value").eq("user_id", user_id),
      supabase.from("entities").select("name, type, properties").limit(10),
      supabase.from("model_capabilities").select("model_id, display_name, max_context_tokens, supports_tools"),
      supabase.from("implementations").select("work_order_id, status, approach_taken, blockers_encountered").order("created_at", { ascending: false }).limit(3),
      supabase.from("metis_capabilities").select("capability_type, name, status, implementation").eq("status", "active"),
    ];

    if (embedding) {
      contextPromises.push(
        supabase.rpc("search_conversations_semantic", { query_embedding: '[' + embedding.join(',') + ']', match_threshold: 0.4, match_count: 3, filter_source: null, filter_org: null })
      );
    }

    const results = await Promise.all(contextPromises);

    const directives = results[0].data || [];
    const project = results[1].data;
    const decisions = results[2].data || [];
    const history = results[3].data || [];
    const backlog = results[4].data || [];
    const workOrders = results[5].data || [];
    const systemStatus = results[6].data || [];
    const agents = results[7].data || [];
    const userPrefs = results[8].data || [];
    const entities = results[9].data || [];
    const models = results[10].data || [];
    const implementations = results[11].data || [];
    const capabilities = results[12].data || [];
    const memories = results[13]?.data || [];

    const activeWoIds = workOrders.map((wo: any) => wo.id).filter(Boolean);
    let executionLogs: any[] = [];
    if (activeWoIds.length > 0) {
      const { data: logs } = await supabase
        .from("work_order_execution_log")
        .select("work_order_id, phase, agent_name, detail, iteration, created_at")
        .in("work_order_id", activeWoIds)
        .order("created_at", { ascending: false })
        .limit(30);
      executionLogs = logs || [];
    }

    const prefsMap: Record<string, any> = {};
    userPrefs.forEach((p: any) => { prefsMap[p.key] = p.value; });

    // ===== BUILD INTENT DETECTION =====
    const isQuestion = /\?|what|where|how|why|when|who|status|summary|summarize|pick up|left off|current|show me|list|check|tell me|explain|which|can you/i.test(msgLower);
    const buildPhrases = ["create a", "build a", "build me", "implement a", "deploy a", "add a new", "write a", "make a", "make me", "set up a", "i want a", "i need a", "i want to build", "i need to build", "let's build", "can you build", "help me build"];
    const hasBuildPhrase = buildPhrases.some(p => msgLower.includes(p));
    // Don't create WOs when in plan mode — user must explicitly transition with "build it"
    const shouldCreateWorkOrder = !isQuestion && hasBuildPhrase && hasTechNoun && !isInPlanMode;

    let workOrderSlug: string | null = null;
    let intakeGateMessage: string | null = null;

    if (shouldCreateWorkOrder) {
      // Check if this is a NEW project request (not for existing METIS-001/ENDGAME)
      const isNewProjectRequest = project_code === 'METIS-001' && !msgLower.includes('endgame') && !msgLower.includes('metis');

      if (isNewProjectRequest) {
        // ===== CONVERSATIONAL INTAKE: Create project + start interrogation =====
        try {
          // Extract project name from message
          const nameMatch = message.match(/(?:build|create|make|implement|set up)\s+(?:me\s+)?(?:a\s+)?(.+?)(?:\s+(?:with|using|that|for|in)\b|$)/i);
          const projectName = nameMatch ? nameMatch[1].trim().slice(0, 100) : message.slice(0, 100);
          const projectCode = 'PROJ-' + Date.now().toString(36).toUpperCase();

          // Create project_brief
          const { data: newProject, error: projErr } = await supabase
            .from('project_briefs')
            .insert({
              code: projectCode,
              name: projectName,
              status: 'intake',
              summary: message,
              created_by: user_id,
              current_phase: 0,
              completion_pct: 0
            })
            .select('id, code, name')
            .single();

          if (projErr) throw projErr;

          // Start interrogation for this project
          const { data: sessionId, error: intError } = await supabase.rpc('start_interrogation', {
            p_trigger_type: 'conversational_intake',
            p_project_id: newProject.id,
            p_thread_id: thread_id
          });
          if (intError) throw intError;

          // Get first questions
          const { data: intStatus } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });
          const firstDomain = intStatus?.next_domain || 'core';
          const firstQuestions = intStatus?.next_questions || [];
          const allDomains = intStatus?.all_domains || [];

          // Store interrogation state in thread metadata
          await updateThreadMetadata(supabase, thread_id, {
            interrogation_session_id: sessionId,
            project_brief_id: newProject.id,
            project_code: projectCode,
            project_name: projectName,
            current_domain: firstDomain,
            interrogation_active: true,
            pending_build_request: message,
            phase: 'interrogating'
          });

          // Format first questions conversationally
          const conversationalQuestions = await formatQuestionsConversationally(
            anthropic, firstQuestions, firstDomain, projectName,
            0, allDomains.length, true
          );

          const responseMsg = `I'll help you build **${projectName}**. I've created project \`${projectCode}\` and need to understand a few things before we start.\n\n${conversationalQuestions}`;

          await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
          await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: responseMsg });

          try {
            await supabase.from('traces').update({
              status: 'completed', ended_at: new Date().toISOString(),
              output: { conversational_intake: true, project_code: projectCode, session_id: sessionId },
              metadata: { version: 'v44', conversational_intake: true }
            }).eq('trace_id', chatTraceId);
          } catch (_) {}

          if (langfuse) await langfuse.flushAsync();

          return respond({
            thread_id, message: responseMsg,
            project: { code: projectCode, name: projectName, id: newProject.id },
            interrogation_session_id: sessionId,
            context: { conversational_intake: true, project_code: projectCode, trace_id: chatTraceId }
          });
        } catch (newProjErr: any) {
          console.error('[CONVERSATIONAL-INTAKE] Failed to create project:', newProjErr);
          // Fall through to legacy WO creation
        }
      }

      // Legacy flow: existing project with intake gate
      if (project?.id) {
        const { data: intakeCheck } = await supabase.rpc('check_project_intake_ready', { p_project_id: project.id });

        if (intakeCheck && !intakeCheck.ready) {
          const missing = intakeCheck.missing_doc_types || [];

          // Auto-interrogation
          try {
            const { data: sessionId, error: intError } = await supabase.rpc('start_interrogation', {
              p_trigger_type: 'auto_intake_gate', p_project_id: project.id, p_thread_id: thread_id
            });

            if (!intError && sessionId) {
              const { data: intStatus } = await supabase.rpc('get_interrogation_status', { p_session_id: sessionId });

              const questions = intStatus?.next_questions || [];
              const domain = intStatus?.next_domain || 'unknown';
              const qList = questions.map((q: any, i: number) => (i+1) + '. ' + q.question).join('\n\n');

              const autoIntMsg = '**Auto-interrogation started** — your build request needs project context first.\n\nProject **' + project_code + '** has ' + intakeCheck.generated_or_approved + '/' + intakeCheck.required + ' required docs. Missing: ' + missing.join(', ') + '.\n\n> Your request: _"' + message.slice(0, 150) + '"_\n> **Work order will be created after interrogation + doc generation completes.**\n\nSession: `' + sessionId + '`\nDomain: **' + domain + '** (1 of ' + (intStatus?.all_domains?.length || 7) + ')\n\n' + qList + '\n\nAnswer using:\n`/interrogate-answer ' + sessionId + ' ' + domain + ' Your answers here`\n\nAfter all domains are answered, run:\n`/generate-docs ' + sessionId + '`\nThen resubmit your build request.';

              await supabase.from("thread_messages").insert({ thread_id, role: "user", content: message });
              await supabase.from("thread_messages").insert({ thread_id, role: "assistant", content: autoIntMsg });

              try {
                await supabase.from('traces').update({
                  status: 'completed', ended_at: new Date().toISOString(),
                  output: { auto_interrogation: true, session_id: sessionId, missing_docs: missing },
                  metadata: { version: 'v44', auto_interrogation: true }
                }).eq('trace_id', chatTraceId);
              } catch (_) {}

              if (langfuse) await langfuse.flushAsync();

              return respond({
                thread_id, message: autoIntMsg, auto_interrogation: true,
                interrogation_session_id: sessionId, interrogation_status: intStatus,
                deferred_work_order: message.slice(0, 200),
                context: { project: project_code, auto_interrogation: true, missing_docs: missing, data_loaded_at: loadTimestamp, trace_id: chatTraceId }
              });
            }
          } catch (autoIntErr: any) {
            console.error('[AUTO-INTERROGATION] Failed, falling back:', autoIntErr);
          }

          intakeGateMessage = '**Intake gate:** Project ' + project_code + ' has ' + intakeCheck.generated_or_approved + '/' + intakeCheck.required + ' required docs. Missing: ' + missing.join(', ') + '. Run `/interrogate` to generate project documentation before creating work orders.';
        }
      }

      if (!intakeGateMessage) {
        const ilmarinen = agents.find((a: any) => a.name === 'ilmarinen');
        const slug = 'WO-' + Date.now().toString(36).toUpperCase();
        const { error: woError } = await supabase.from("work_orders").insert({
          slug, name: message.slice(0, 200), objective: message, status: "draft", priority: "p2_medium",
          created_by: "cto", assigned_to: ilmarinen?.id || null, tags: ["auto-created", "portal"],
          source: "portal", request_id: trace?.id || null,
        });
        if (!woError) workOrderSlug = slug;
      }
    }

    const hardConstraints = directives.filter((d: any) => d.enforcement === 'hard');
    const softRules = directives.filter((d: any) => d.enforcement !== 'hard');

    const agentsList = agents.map((a: any) => a.name + ' (' + a.agent_type + ', ' + a.status + '): ' + (a.description?.slice(0, 60) || '')).join('\n');
    const systemList = systemStatus.map((s: any) => {
      const m = s.metadata || {};
      const heartbeat = s.last_heartbeat ? 'last seen ' + new Date(s.last_heartbeat).toISOString() : 'no heartbeat';
      return s.component + ': ' + s.status + ' [' + heartbeat + ']' + (m.host ? ' host=' + m.host : '');
    }).join('\n');

    const woList = workOrders.map((wo: any) => {
      const agent = agents.find((a: any) => a.id === wo.assigned_to);
      const woLogs = executionLogs.filter((l: any) => l.work_order_id === wo.id);
      let logSection = '';
      if (woLogs.length > 0) {
        const logDetails = woLogs.slice(0, 5).map((l: any) => {
          const detail = l.detail || {};
          const detailStr = Object.keys(detail).length > 0
            ? ' (' + Object.entries(detail).map(([k, v]) => k + '=' + v).join(', ') + ')'
            : '';
          return '    - ' + l.phase + detailStr + ' @ ' + new Date(l.created_at).toISOString();
        }).join('\n');
        logSection = '\n  Execution Log (' + woLogs.length + ' entries):\n' + logDetails;
      }
      return wo.slug + ' [' + wo.status + '] (via ' + (wo.source || 'unknown') + '): ' + wo.name + '\n  Assigned: ' + (agent?.name || 'unassigned') + (wo.approved_at ? ' | approved' : '') + logSection;
    }).join('\n\n') || 'None active';

    const capabilitiesList = capabilities.map((c: any) => c.capability_type + '/' + c.name).join(', ');
    const decisionsList = decisions.map((d: any) => d.subject + ': ' + d.choice).join('\n');
    const hardConstraintsList = hardConstraints.map((d: any) => d.name + ': ' + d.content).join('\n');
    const softRulesList = softRules.map((d: any) => d.name + ': ' + d.content.slice(0, 80) + '...').join('\n');

    const workOrderNotice = workOrderSlug ? '\n\n---\nWork Order Created: ' + workOrderSlug + '. Approve in Workspace to enable execution.' : '';
    const gateNotice = intakeGateMessage ? '\n\n---\n' + intakeGateMessage : '';

    // Plan mode system prompt section
    const planModeSection = isInPlanMode
      ? '\n## PLAN MODE ACTIVE\nYou are in PLAN MODE. Help the user explore, scope, and refine their idea through multi-turn conversation.\n- Ask clarifying questions to understand requirements, constraints, and goals\n- Suggest architecture patterns, technology choices, and trade-offs\n- Help estimate scope, complexity, and potential risks\n- Structure your responses as evolving plans (use headers, bullet points, tables)\n- Do NOT create work orders or trigger builds yet\n- Do NOT say you cannot plan — you ARE planning\n- When the user is satisfied, tell them to say "build it" or "let\'s build" to transition to build mode and create work orders\n- User can also say "cancel planning" or "/exit-plan" to exit plan mode without building\n- Keep track of decisions made during the planning conversation\n'
      : '';

    const systemPrompt = 'You are METIS, the orchestration AI for the Endgame system.\n\n## CRITICAL CONSTRAINTS\n' + hardConstraintsList + '\n\n## DATA FRESHNESS\nAll data below was loaded at **' + loadTimestamp + '**.\n- Present as "From loaded context..." or "The data shows..." - NOT "I can see..."\n- You have NO ability to run additional queries. Work with what\'s provided.\n\n## CAPABILITIES (' + capabilities.length + ' registered)\n' + (capabilitiesList || 'None registered') + '\n' + planModeSection + '\n## TEAM (' + agents.length + ' agents)\n' + agentsList + '\n\n## SYSTEM COMPONENTS\n' + systemList + '\n\n## WORK ORDERS\n' + woList + '\n\n## PROJECT: ' + (project?.code || 'N/A') + '\nPhase: ' + (project?.current_phase || '?') + ' | Completion: ' + (project?.completion_pct || 0) + '%\n' + (project?.summary || '') + '\n\n## KEY DECISIONS\n' + (decisionsList || 'None') + '\n\n## GUIDELINES\n' + softRulesList + '\n\n## COMMANDS\n- /plan <topic> - Enter plan mode for multi-turn exploration and scoping\n- /build or "build it" - Transition from plan mode to build mode (creates work orders)\n- /exit-plan or "cancel planning" - Exit plan mode without building\n- /interrogate - Start a structured interrogation session for current project\n- /interrogate-answer <session_id> <domain> <answers> - Submit answers to interrogation\n- /generate-docs <session_id> - Generate 8-doc framework from interrogation answers\n- /summary [hours] - Show session summary with pseudosystem stats (default: 24h)\n\n## CONVERSATION MODES\n- **Normal**: Answer questions, provide status, discuss the system\n- **Plan mode**: Multi-turn exploration and scoping. Help refine ideas before committing to work orders. User says "build it" to transition or "cancel planning" to exit.\n- **Build mode**: Concrete build requests trigger project creation, interrogation, and WO decomposition\n\n## BUILD REQUESTS\nWhen users say "build me X", METIS creates a project and asks clarifying questions conversationally. No slash commands needed — just describe what you want to build.\n\n## RESPONSE FORMAT\n- Plain markdown only\n- Be direct, synthesize from the data above\n- Acknowledge gaps honestly\n' + workOrderNotice + gateNotice + '\n';

    const messages: Array<{ role: "user" | "assistant"; content: any }> = [];
    for (const msg of history) {
      if (msg.role === "user" || msg.role === "assistant") {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Build multi-modal content blocks for attachments
    if (attachments.length > 0) {
      const contentBlocks: any[] = [];

      // Add text file contents as context
      const textFiles = attachments.filter(a => a.textContent);
      if (textFiles.length > 0) {
        const fileContext = textFiles.map(f =>
          `--- File: ${f.name} (${f.type}) ---\n${f.textContent}\n--- End ${f.name} ---`
        ).join('\n\n');
        contentBlocks.push({ type: 'text', text: `[Attached files]\n${fileContext}\n\n[User message]\n${message}` });
      } else {
        contentBlocks.push({ type: 'text', text: message });
      }

      // Add images as vision blocks
      const imageFiles = attachments.filter(a => a.base64);
      for (const img of imageFiles) {
        const mediaType = img.type || 'image/png';
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: img.base64 }
        });
      }

      messages.push({ role: "user", content: contentBlocks });
    } else {
      messages.push({ role: "user", content: message });
    }

    // Store message text (without base64 data)
    const storedContent = attachments.length > 0
      ? message + '\n\n[Attachments: ' + attachments.map(a => a.name).join(', ') + ']'
      : message;
    await supabase.from("thread_messages").insert({ thread_id, role: "user", content: storedContent });

    const apiRequest = { model: "claude-sonnet-4-20250514", max_tokens: 4096, system: systemPrompt, messages };

    let generation: any = null;
    if (trace) {
      generation = trace.generation({ name: "claude-chat", model: apiRequest.model, input: { system: systemPrompt, messages } });
    }

    try {
      const { data: spanId } = await supabase.rpc('emit_harness_span', {
        p_trace_id: chatTraceId, p_span_type: 'llm-generation',
        p_name: 'llm:' + apiRequest.model,
        p_input: { model: apiRequest.model, max_tokens: apiRequest.max_tokens, message_count: messages.length, system_prompt_chars: systemPrompt.length },
        p_metadata: { version: 'v44', thread_id }
      });
      llmSpanId = spanId;
    } catch (spanErr) {
      console.error('[SPAN] Failed to emit LLM span:', spanErr);
    }

    let response;
    try {
      response = await anthropic.messages.create(apiRequest);
    } catch (llmError: any) {
      if (llmSpanId) {
        try {
          await supabase.rpc('complete_harness_span', {
            p_span_id: llmSpanId,
            p_status: 'error',
            p_error_message: 'LLM call failed: ' + (llmError.message || 'unknown error').slice(0, 500),
            p_latency_ms: Date.now() - startTime,
            p_metadata: { model: apiRequest.model, version: 'v44', thread_id, error_type: llmError.constructor?.name || 'Error' }
          });
          llmSpanId = null;
        } catch (spanErr) {
          console.error('[SPAN] Failed to error-complete LLM span:', spanErr);
        }
      }
      throw llmError;
    }

    const assistantContent = response.content[0].type === "text" ? response.content[0].text : "";
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const costUsd = (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
    const latencyMs = Date.now() - startTime;

    if (llmSpanId) {
      try {
        await supabase.rpc('complete_harness_span', {
          p_span_id: llmSpanId,
          p_output: {
            model: apiRequest.model, input_tokens: inputTokens, output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens, response_chars: assistantContent.length,
            stop_reason: response.stop_reason || 'end_turn'
          },
          p_status: 'completed', p_cost_usd: costUsd,
          p_input_tokens: inputTokens, p_output_tokens: outputTokens, p_latency_ms: latencyMs,
          p_metadata: { model: apiRequest.model, version: 'v44', thread_id, completed_by: 'portal-chat' }
        });
      } catch (spanErr) {
        console.error('[SPAN] Failed to complete LLM span:', spanErr);
      }
    }

    try {
      await supabase.from('traces').update({
        status: 'completed', ended_at: new Date().toISOString(),
        output: { response_chars: assistantContent.length, latency_ms: latencyMs },
        total_cost_usd: costUsd, total_tokens: inputTokens + outputTokens
      }).eq('trace_id', chatTraceId);
    } catch (traceErr) {
      console.error('[TRACE] Failed to complete trace:', traceErr);
    }

    if (generation) generation.end({ output: assistantContent, usage: { input: inputTokens, output: outputTokens } });

    await supabase.from("thread_messages").insert({
      thread_id, role: "assistant", content: assistantContent, model_used: "claude-sonnet-4-20250514",
      input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, trace_id: trace?.id || null,
    });

    const { data: threadStats } = await supabase.from("thread_messages").select("cost_usd").eq("thread_id", thread_id);
    const totalCost = (threadStats || []).reduce((sum: number, m: any) => sum + parseFloat(m.cost_usd || 0), 0);
    await supabase.from("conversation_threads").update({ message_count: (threadStats || []).length, total_cost_usd: totalCost, updated_at: new Date().toISOString() }).eq("id", thread_id);

    if (langfuse) await langfuse.flushAsync();

    return respond({
      thread_id, message: assistantContent,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd, latency_ms: latencyMs },
      context: {
        project: project_code, work_order_created: workOrderSlug, intake_gate_blocked: !!intakeGateMessage,
        agents_loaded: agents.length, components_loaded: systemStatus.length,
        capabilities_loaded: capabilities.length, execution_logs_loaded: executionLogs.length,
        data_loaded_at: loadTimestamp, trace_id: chatTraceId, llm_span_id: llmSpanId,
        plan_mode: isInPlanMode,
        plan_topic: isInPlanMode ? (threadMeta.plan_topic || null) : null,
        attachments_count: attachments.length,
        plan_build_transition_fixed: true
      },
    });

  } catch (error: any) {
    console.error("portal-chat error:", error);

    if (llmSpanId) {
      try {
        await supabase.rpc('complete_harness_span', {
          p_span_id: llmSpanId,
          p_status: 'error',
          p_error_message: 'Unhandled error: ' + (error.message || 'unknown').slice(0, 500),
          p_latency_ms: Date.now() - startTime,
          p_metadata: { version: 'v44', error_type: error.constructor?.name || 'Error', caught_in: 'outer_catch' }
        });
      } catch (_) {
        console.error('[SPAN] Failed to error-complete span in outer catch');
      }
    }

    if (chatTraceId) {
      try {
        await supabase.from('traces').update({
          status: 'error', ended_at: new Date().toISOString(),
          error_message: (error.message || 'unknown').slice(0, 500)
        }).eq('trace_id', chatTraceId);
      } catch (_) {
        console.error('[TRACE] Failed to error-complete trace in outer catch');
      }
    }

    if (langfuse) await langfuse.flushAsync();
    return respond({ error: error.message }, 500);
  }
});
