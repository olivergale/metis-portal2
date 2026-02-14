FROM denoland/deno:2.1.4

# Create sandbox user and workspace
RUN useradd -m -s /bin/bash sandbox && \
    mkdir -p /workspace && \
    chown -R sandbox:sandbox /workspace

# Set working directory
WORKDIR /app

# Copy application files
COPY --chown=sandbox:sandbox . .

# Switch to sandbox user
USER sandbox

# Expose port
EXPOSE 8080

# Run the application
CMD ["deno", "run", "--allow-net", "--allow-read", "--allow-write=/workspace", "--allow-env", "--allow-run", "main.ts"]
