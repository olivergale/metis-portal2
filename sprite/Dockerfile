# Sprite Base Image — Model-Agnostic Agent Runtime
# Runs wo-agent (agent-loop.ts + tools) natively in Fly Machine
# No wall-clock limit, direct filesystem access, any LLM via OpenRouter

FROM denoland/deno:2.1.4

# System dependencies (minimal — Deno handles TS natively)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git jq curl inotify-tools procps \
  && apt-get clean && apt-get autoremove -y

# Workspace setup
RUN mkdir -p /workspace /workspace/.mutations /var/log/sprite

# Copy sprite runtime files
WORKDIR /app
COPY entrypoint.sh mutation-watcher.sh health-server.ts sprite-agent.ts ./
RUN chmod +x entrypoint.sh mutation-watcher.sh

EXPOSE 8080

# Environment variables (injected at runtime, never baked in):
# ANTHROPIC_API_KEY, OPENROUTER_API_KEY — LLM access
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — DB access
# GITHUB_TOKEN — repo access
# WO_ID, WO_SLUG, WO_OBJECTIVE — work order context
# AGENT_MODEL — model to use (default: minimax/minimax-m2.5)
# SPRITE_MODE — "agent" (run agent loop) or "sandbox" (exec server)

ENTRYPOINT ["./entrypoint.sh"]
