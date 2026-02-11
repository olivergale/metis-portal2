#!/bin/bash
# Install git hooks for metis-portal2

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Installing git hooks...${NC}"

# Make hooks executable
chmod +x .githooks/pre-push

# Configure git to use this hooks directory
git config core.hooksPath .githooks

echo -e "${GREEN}✓ Git hooks installed successfully!${NC}"
echo ""
echo "Installed hooks:"
echo "  • pre-push - Prevents CLI-API race condition"
echo ""
echo "To disable hooks: git config --unset core.hooksPath"
echo "To bypass a hook once: git push --no-verify"
