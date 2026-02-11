# METIS Portal - Setup Guide

## Quick Start for New Developers

This guide will help you set up the METIS system from scratch.

### Prerequisites

- [Deno](https://deno.land/) v1.40+ (for edge functions development)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for local development and deployments)
- Git

### 1. Clone the Repository

```bash
git clone <repository-url>
cd metis-portal2
```

### 2. Install Git Hooks (Recommended)

Install git hooks to prevent common issues:

```bash
# Run the install script
bash .githooks/install.sh

# Or manually
git config core.hooksPath .githooks
chmod +x .githooks/pre-push
```

**Available hooks:**
- `pre-push` - Prevents CLI-API race condition by blocking pushes when remote has commits not in local

See [`.githooks/README.md`](.githooks/README.md) for details.

### 3. Install Dependencies

```bash
# Install Deno (if not already installed)
curl -fsSL https://deno.land/x/install/install.sh | sh

# Install Supabase CLI (if not already installed)
brew install supabase/tap/supabase  # macOS
# or
npm install -g supabase              # via npm
```

### 3. Configure Environment Variables

```bash
# Copy the example env file
cp .env.example .env

# Edit .env and fill in your values
# Follow the setup checklist in .env.example
```

#### Required Variables (see `.env.example` for details):

**From Supabase Dashboard:**
- `SUPABASE_URL` - Your project URL
- `SUPABASE_ANON_KEY` - Public anon key
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key (keep secret!)

**Manual Setup Required:**
- `ANTHROPIC_API_KEY` - Get from https://console.anthropic.com/
- `OPENAI_API_KEY` - Get from https://platform.openai.com/
- `LANGFUSE_PUBLIC_KEY` - Get from https://cloud.langfuse.com/
- `LANGFUSE_SECRET_KEY` - Get from https://cloud.langfuse.com/
- `LANGFUSE_BASE_URL` - Set to your region (US or EU)

**Optional:**
- `GITHUB_TOKEN` - For GitHub integration
- `NOTION_TOKEN` - For Notion sync

### 4. Configure Edge Function Secrets

Edge functions need environment variables configured in Supabase:

```bash
# Login to Supabase CLI
supabase login

# Link to your project
supabase link --project-ref phfblljwuvzqzlbzkzpr

# Set secrets for edge functions
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set LANGFUSE_PUBLIC_KEY=pk-lf-...
supabase secrets set LANGFUSE_SECRET_KEY=sk-lf-...
supabase secrets set LANGFUSE_BASE_URL=https://us.cloud.langfuse.com

# Optional secrets
supabase secrets set GITHUB_TOKEN=ghp_...
supabase secrets set NOTION_TOKEN=secret_...

# List configured secrets
supabase secrets list
```

**Note:** `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are automatically injected into edge functions by Supabase.

### 5. Generate Lock File (Optional)

The `deno.lock` file ensures reproducible dependency resolution:

```bash
# Generate/update lock file
deno task lock

# Or manually:
deno cache --lock=deno.lock --lock-write supabase/functions/*/index.ts
```

### 6. Deploy Edge Functions

```bash
# Deploy all functions
supabase functions deploy portal-chat
supabase functions deploy langfuse
supabase functions deploy audit-enforcer
# ... deploy other functions as needed

# Or deploy all at once
for func in supabase/functions/*/; do
  func_name=$(basename "$func")
  supabase functions deploy "$func_name"
done
```

### 7. Verify Setup

```bash
# Test edge function deployment
supabase functions list

# Test API connectivity
curl https://phfblljwuvzqzlbzkzpr.supabase.co/rest/v1/agents \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

## Project Structure

```
metis-portal2/
âââ .env.example          # Environment variable template
âââ deno.json             # Shared Deno configuration and import map
âââ deno.lock             # Dependency lock file
âââ README.md             # This file
âââ supabase/
â   âââ functions/        # Edge functions
â       âââ portal-chat/
â       âââ langfuse/
â       âââ audit-enforcer/
â       âââ ...
âââ index.html            # Portal UI
âââ workspace.html        # Workspace UI
âââ docs/                 # Documentation
```

## Development Workflow

### Local Development

```bash
# Run a function locally
deno run --allow-net --allow-read --allow-env \
  supabase/functions/portal-chat/index.ts

# Or use the task runner
deno task dev
```

### Adding New Dependencies

When adding a new dependency to edge functions:

1. Add it to the `imports` section in `deno.json`
2. Update the lock file: `deno task lock`
3. Commit both `deno.json` and `deno.lock`

### Deploying Changes

```bash
# Deploy specific function
supabase functions deploy <function-name>

# Deploy with environment variables
supabase functions deploy <function-name> \
  --import-map deno.json
```

## Troubleshooting

### Edge Function Deployment Fails

- Verify secrets are set: `supabase secrets list`
- Check function logs: `supabase functions logs <function-name>`
- Ensure you're linked to correct project: `supabase projects list`

### Import Errors

- Make sure `deno.json` is in the project root
- Regenerate lock file: `deno task lock`
- Clear Deno cache: `deno cache --reload supabase/functions/*/index.ts`

### Authentication Errors

- Verify API keys are correct in `.env`
- Check that `SUPABASE_URL` matches your project
- Ensure service role key is set for backend operations

## Architecture

### Shared Import Map

All edge functions use shared imports defined in `deno.json`:

- `@supabase/supabase-js` - Supabase client
- `@anthropic-ai/sdk` - Claude API
- `langfuse` - Observability
- `std/` - Deno standard library

This ensures:
- Consistent dependency versions across all functions
- Faster deployments (shared dependencies)
- Easier dependency management

### Environment Variables

Variables are configured in two places:

1. **Local development** - `.env` file (not committed)
2. **Production (edge functions)** - Supabase secrets (via CLI or Dashboard)

## Support

- Documentation: `/Users/OG/projects/metis-portal2/docs/`
- Issues: See project issue tracker
- Work Orders: Use `./wo` CLI tool

## Next Steps

After setup:

1. Run the daemon (if applicable)
2. Access the portal at the deployed URL
3. Create your first work order via the portal or CLI
4. Explore the workspace UI for system status

---

**Note:** This is the METIS/ENDGAME-001 system. The Supabase project is named "Master Layer Memory" (legacy), but the actual project code is ENDGAME-001.
