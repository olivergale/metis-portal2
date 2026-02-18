# Base Fly Machine Docker image for Sprites
# Model-agnostic autonomous agent execution environments

FROM ubuntu:22.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install base dependencies and required tools
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
    build-essential \
    ca-certificates \
    gnupg \
    inotify-tools \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Deno
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"

# Install Supabase CLI
RUN npm install -g supabase

# Install Claude Code CLI
RUN curl -fsSL https://raw.githubusercontent.com/anthropics/claude-code/main/install.sh | sh
ENV CLAUDE_CLI_PATH="/root/.claude/bin"
ENV PATH="$CLAUDE_CLI_PATH:$PATH"

# Install TypeScript compiler
RUN npm install -g typescript

# Create workspace directory
RUN mkdir -p /workspace

# Copy entrypoint and mutation watcher
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY mutation-watcher.sh /usr/local/bin/mutation-watcher.sh

RUN chmod +x /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/mutation-watcher.sh

# Create mutations log file
RUN touch /workspace/.mutations.jsonl

# Expose health endpoint port
EXPOSE 8080

# Default command
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD []
