# Sprite Base Image — Full-Capability Agent Runtime
# Persistent Fly Machine: boot → clone → agent loop → push → self-destruct
# Rich tooling — Sprites persist for WO duration (minutes-hours), optimize for capability

FROM denoland/deno:2.1.4

# Cache buster for NodeSource layer
ARG CACHEBUST=2

# Node.js 22 + system deps + Python 3 — single layer ensures NodeSource repo is used
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y \
    ca-certificates git jq curl wget unzip \
    inotify-tools procps \
    nodejs \
    python3 python3-pip python3-venv \
    postgresql-client \
  && node --version && npm --version \
  && apt-get clean && apt-get autoremove -y

# Supabase CLI + Claude Code CLI (via npm)
RUN npm install -g supabase @anthropic-ai/claude-code

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
