FROM node:20-slim

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    grep \
    sed \
    findutils \
    jq \
    curl \
    python3 \
    diffutils \
    file \
    && rm -rf /var/lib/apt/lists/*

# Install TypeScript globally
RUN npm install -g typescript

# Create workspace directory
RUN mkdir -p /workspace

# Clone metis-portal2 repository
RUN git clone https://github.com/olivergale/metis-portal2.git /workspace/main

# Set working directory
WORKDIR /app

# Copy package.json and exec-server.js
COPY package.json exec-server.js ./

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "exec-server.js"]
