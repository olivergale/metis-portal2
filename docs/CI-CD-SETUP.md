# CI/CD Setup Documentation

## Overview

This document describes the CI/CD pipeline setup for the METIS system, including automated testing, linting, and deployment validation.

## Pipeline Architecture

The GitHub Actions workflow (`.github/workflows/ci.yml`) provides:

1. **Lint Stage**: Code quality checks
2. **Schema Validation**: Database structure verification
3. **Integration Tests**: Work Order lifecycle and edge function tests
4. **Function Validation**: Edge function signature and type checking
5. **Summary Stage**: Aggregated results and deployment gate

## GitHub Actions Workflow

### Triggers

- Push to `main` or `develop` branches
- Pull requests targeting `main` or `develop`

### Jobs

#### 1. Lint (`lint`)

- Runs Deno linting on edge functions
- Checks code formatting
- Blocks deployment on lint failures

**Commands:**
```bash
deno lint supabase/functions/
deno fmt --check supabase/functions/
```

#### 2. Schema Validation (`validate-schema`)

- Verifies database tables exist
- Checks RPC function availability
- Tests basic schema structure

**Dependencies:** `lint`

#### 3. Integration Tests (`test-integration`)

- Tests Work Order lifecycle (create → start → review → complete)
- Validates edge function availability
- Runs against production database with test data isolation

**Dependencies:** `lint`, `validate-schema`

#### 4. Function Validation (`validate-functions`)

- Type checks all edge functions
- Validates function signatures
- Checks for breaking changes

**Dependencies:** `lint`

#### 5. Test Results Summary (`test-results`)

- Aggregates all test results
- Provides clear pass/fail status
- Blocks deployment on any failure

**Dependencies:** All previous jobs

## Setup Instructions

### 1. GitHub Repository Setup

1. Go to repository Settings → Secrets and variables → Actions
2. Add repository secret:
   - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase service role key

### 2. Local Testing

Before pushing, run tests locally:

```bash
cd metis-portal2

# Set environment variables
export SUPABASE_SERVICE_ROLE_KEY="your-key-here"
export SUPABASE_URL="https://phfblljwuvzqzlbzkzpr.supabase.co"
export SUPABASE_PROJECT_REF="phfblljwuvzqzlbzkzpr"

# Run all tests
deno task test

# Run specific test suites
deno task test:wo
deno task test:functions
deno task test:schema
```

### 3. CI Execution

When you push code:

1. GitHub Actions automatically triggers the workflow
2. All jobs run in parallel where possible
3. Results appear in the Actions tab
4. Failed jobs block deployment

## Database Testing Strategy

### Challenge: No Staging Branch

Supabase branching requires Pro plan. Current approach:

- Tests run against production database
- Test data uses `WO-TEST-` prefix
- Automatic cleanup after test runs
- Isolated work orders don't interfere with production

### Test Data Management

```typescript
// From test/config.ts
export async function cleanupTestWorkOrders(supabaseUrl: string, supabaseKey: string) {
  const testPrefix = "WO-TEST-";
  // Delete all work orders with test prefix
}
```

### Alternative: Transaction Rollback

Future improvement: Use database transactions with rollback for true isolation.

## Test Coverage

### Work Order Lifecycle (5 tests)

1. Create draft work order
2. Start work order
3. Move to review
4. Complete work order
5. Cleanup test data

### Edge Functions (3 tests)

1. work-order endpoint availability
2. context-load endpoint availability
3. orchestrate endpoint availability

### Schema Validation (5 tests)

1. work_orders table exists
2. agents table exists
3. system_manifest table exists
4. create_draft_work_order RPC exists
5. start_work_order RPC exists

## Pipeline Metrics

- **Average Runtime**: ~3-5 minutes
- **Parallel Jobs**: 4 (lint, schema, functions run concurrently)
- **Test Count**: 13 integration tests
- **Deployment Gate**: All jobs must pass

## Troubleshooting

### Test Failures

1. Check GitHub Actions logs for specific failures
2. Run failing tests locally:
   ```bash
   deno task test:wo  # If WO lifecycle fails
   ```
3. Verify environment variables are set correctly

### CI Authentication Issues

- Verify `SUPABASE_SERVICE_ROLE_KEY` secret is set in GitHub
- Check that the key has proper permissions

### Lint Failures

```bash
# Fix formatting
cd metis-portal2
deno fmt supabase/functions/

# Fix lint issues
deno lint supabase/functions/
```

### Type Check Failures

```bash
# Check specific function
deno check supabase/functions/work-order/index.ts
```

## Future Enhancements

### Staging Branch (When Available)

Once Supabase Pro plan is active:

1. Create `staging` branch in Supabase
2. Update test configuration to use staging
3. Enable true database isolation
4. Add pre-deployment migration validation

### Additional Tests

- [ ] Performance tests for edge functions
- [ ] Load tests for work order creation
- [ ] Security tests for RLS policies
- [ ] Integration tests for external APIs

### Deployment Automation

- [ ] Auto-deploy to staging on PR merge
- [ ] Manual approval gate for production
- [ ] Automated rollback on deployment failures

## Related Documentation

- [Test Suite README](../test/README.md)
- [Edge Function Development Guide](./EDGE-FUNCTIONS.md)
- [Database Schema Documentation](../ENDGAME-001-ARCHITECTURE.md)

## Support

For CI/CD issues:
1. Check GitHub Actions logs
2. Review this documentation
3. Test locally before pushing
4. Consult team for persistent issues
