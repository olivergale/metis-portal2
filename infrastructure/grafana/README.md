# Grafana Observability Stack

This directory contains the Grafana deployment configuration and dashboard definitions for monitoring the ENDGAME system.

## Prerequisites

- Docker and Docker Compose installed
- PostgreSQL database accessible (Supabase instance)
- Network access to the PostgreSQL database

## Environment Variables

Create a `.env` file or set these environment variables before starting:

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_HOST` | PostgreSQL host and port | `localhost:5432` |
| `POSTGRES_DB` | Database name | `postgres` |
| `POSTGRES_USER` | Database user | `postgres` |
| `POSTGRES_PASSWORD` | Database password | (required) |
| `GRAFANA_ADMIN_USER` | Grafana admin username | `admin` |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password | `admin` |

## Quick Start

1. Navigate to this directory:
   ```bash
   cd infrastructure/grafana
   ```

2. Start Grafana:
   ```bash
   docker-compose up -d
   ```

3. Access Grafana at: http://localhost:3000
   - Default credentials: admin / admin

## Dashboard URLs

After startup, access these dashboards:

| Dashboard | URL |
|-----------|-----|
| Mutation Velocity | http://localhost:3000/d/mutation-velocity |
| Agent Performance | http://localhost:3000/d/agent-performance |
| Pipeline Status | http://localhost:3000/d/pipeline-status |
| Ontology Health | http://localhost:3000/d/ontology-health |

## Data Sources

The Supabase PostgreSQL datasource is automatically provisioned on first startup. The datasource queries the following RPCs:

- `get_mutation_velocity(hours)` - Mutation velocity metrics
- `get_agent_performance_summary(days)` - Agent performance data
- `pipeline_runs` table - Pipeline execution status
- `work_orders` table - Work order status
- `object_registry` table - Ontology object counts
- `object_links` table - Ontology relationship counts

## Dashboards

### Mutation Velocity
Shows the rate of mutations over time, useful for understanding system activity.

### Agent Performance
Displays agent execution metrics including work orders completed, failures, and performance summaries.

### Pipeline Status
Monitors active and recent pipeline runs, showing phase progress and status.

### Ontology Health
Provides an overview of the system's ontology state, including object counts by type and link relationships.

## Stopping

```bash
docker-compose down
```

To also remove data volumes:
```bash
docker-compose down -v
```
