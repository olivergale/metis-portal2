# Sprite Base Image — Model-Agnostic Agent Runtime
# Runs wo-agent (agent-loop.ts + tools) natively in Fly Machine
# No wall-clock limit, direct filesystem access, any LLM via OpenRouter

FROM debian:bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    wget \
    git \
    jq \
    inotify-tools \
    procps \
    gnupg \
    ca-certificates \
    build-essential \
    && apt-get clean && apt-get autoremove -y

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g npm@latest

# Install Python 3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    && apt-get clean

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Install Supabase CLI
RUN npm install -g supabase

# Install Claude Code CLI
RUN git clone https://github.com/anthropics/claude-code.git /tmp/claude-code \
    && cd /tmp/claude-code \
    && npm install -g .

# Install TypeScript (for tsc)
RUN npm install -g typescript

# Workspace setup
RUN mkdir -p /workspace /workspace/.mutations /var/log/sprite
WORKDIR /workspace

# Copy sprite runtime files
COPY entrypoint.sh mutation-watcher.sh health-server.ts /workspace/
RUN chmod +x /workspace/entrypoint.sh /workspace/mutation-watcher.sh

# Add scripts to PATH
ENV PATH="/workspace:$PATH"

EXPOSE 8080

# Environment variables (injected at runtime, never baked in):
# ANTHROPIC_API_KEY, OPENROUTER_API_KEY — LLM access
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — DB access
# GITHUB_TOKEN — repo access
# WO_ID, WO_SLUG, WO_OBJECTIVE — work order context
# AGENT_MODEL — model to use (default: minimax/minimax-m2.5)
# SPRITE_MODE — "agent" (run agent loop) or "sandbox" (exec server)

ENTRYPOINT ["/workspace/entrypoint.sh"]
