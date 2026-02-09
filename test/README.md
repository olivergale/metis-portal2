# METIS Integration Test Suite

## Overview

This test suite provides automated testing for the METIS system, including:
- Work Order lifecycle validation
- Edge function availability checks
- Database schema validation
- CI/CD integration via GitHub Actions

## Test Structure

```
test/
├── config.ts                           # Test configuration and utilities
├── integration/
│   ├── wo-lifecycle.test.ts           # Work Order lifecycle tests
│   ├── edge-functions.test.ts         # Edge function validation
│   └── schema-validation.test.ts      # Database schema checks
└── README.md
```

## Running Tests

### Prerequisites

Set up your environment variables:

```bash
export SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
export SUPABASE_URL="https://phfblljwuvzqzlbzkzpr.supabase.co"
export SUPABASE_PROJECT_REF="phfblljwuvzqzlbzkzpr"
```

### Run All Tests

```bash
deno task test
```

### Run Specific Test Suites

```bash
# Work Order lifecycle tests
deno task test:wo

# Edge function tests
deno task test:functions

# Schema validation tests
deno task test:schema

# All integration tests
deno task test:integration
```

### Run Individual Tests

```bash
deno test --allow-net --allow-env --allow-read test/integration/wo-lifecycle.test.ts
```

## CI/CD Integration

The GitHub Actions workflow (`.github/workflows/ci.yml`) automatically runs:

1. **Lint Stage**: Code linting and formatting checks
2. **Validate Stage**: Schema and function signature validation
3. **Test Stage**: Integration tests against production database
4. **Summary Stage**: Aggregated test results

### GitHub Secrets Required

Add these secrets to your GitHub repository:

- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role key for API access

## Test Coverage

### Work Order Lifecycle Tests

- ✅ Create draft work order
- ✅ Start work order
- ✅ Move to review status
- ✅ Complete work order
- ✅ Cleanup test data

### Edge Function Tests

- ✅ work-order endpoint availability
- ✅ context-load endpoint availability
- ✅ orchestrate endpoint availability

### Schema Validation Tests

- ✅ work_orders table exists
- ✅ agents table exists
- ✅ system_manifest table exists
- ✅ create_draft_work_order RPC exists
- ✅ start_work_order RPC exists

## Notes

### Database Isolation

Since Supabase branching requires Pro plan, tests run against production database with:
- Test data prefixed with `WO-TEST-`
- Automatic cleanup after test runs
- Isolated test work orders that don't interfere with production data

### CI Environment

Tests in CI use GitHub secrets for authentication and run in isolated containers.

### Local Development

For local development, source your `.env` file or set environment variables manually.

## Troubleshooting

### Authentication Errors

Ensure `SUPABASE_SERVICE_ROLE_KEY` is set and valid.

### Network Errors

Check that `SUPABASE_URL` is correct and accessible.

### Test Failures

Review test output for specific assertion failures. Tests are designed to be idempotent and can be run multiple times.
