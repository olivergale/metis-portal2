FROM node:20-slim

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    grep \
    sed \
    findutils \
    jq \
    curl \
    unzip \
    python3 \
    diffutils \
    file \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | sh

# Add deno to PATH (hardcoded — Docker ENV doesn't expand $HOME)
ENV DENO_INSTALL="/root/.deno"
ENV PATH="/root/.deno/bin:$PATH"

# Install TypeScript globally
RUN npm install -g typescript

# Create workspace directory (repo cloned at runtime via /git-pull endpoint)
# /workspace is the writable sandbox root — write commands chrooted here
RUN mkdir -p /workspace /var/log

# Set working directory
WORKDIR /app

# Copy package.json and exec-server.js
COPY package.json exec-server.js ./

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "exec-server.js"]
