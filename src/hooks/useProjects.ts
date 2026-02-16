import { useState, useEffect } from 'react';
import { supabase } from '../hooks/useSupabase.ts';
import type { Project } from '../types/index.ts';

interface ProjectWithStats extends Project {
  stream_count: number;
  wo_total: number;
  wo_completed: number;
  wo_in_progress: number;
  wo_failed: number;
  completion_pct: number;
}

export function useProjects() {
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchProjects() {
      try {
        // First get projects
        const { data: projectsData, error: projectsError } = await supabase
          .from('projects')
          .select('*')
          .order('created_at', { ascending: false });

        if (projectsError) throw projectsError;

        if (!projectsData?.length) {
          setProjects([]);
          setLoading(false);
          return;
        }

        // Get stream (pipeline_run) counts per project
        const { data: streamsData, error: streamsError } = await supabase
          .from('pipeline_runs')
          .select('id, project_id, status');

        if (streamsError) throw streamsError;

        // Get WO stats per project
        const { data: woData, error: woError } = await supabase
          .from('work_orders')
          .select('id, status, pipeline_run_id');

        if (woError) throw woError;

        // Build project stats
        const streamCounts: Record<string, number> = {};
        const woStats: Record<string, { total: number; completed: number; in_progress: number; failed: number }> = {};

        // Initialize
        projectsData.forEach(p => {
          streamCounts[p.id] = 0;
          woStats[p.id] = { total: 0, completed: 0, in_progress: 0, failed: 0 };
        });

        // Count streams per project
        streamsData?.forEach(s => {
          if (s.project_id && streamCounts[s.project_id] !== undefined) {
            streamCounts[s.project_id]++;
          }
        });

        // Map pipeline_run_id to project_id
        const streamToProject: Record<string, string> = {};
        streamsData?.forEach(s => {
          if (s.project_id) streamToProject[s.id] = s.project_id;
        });

        // Count WOs per project
        woData?.forEach(wo => {
          if (wo.pipeline_run_id && streamToProject[wo.pipeline_run_id]) {
            const projectId = streamToProject[wo.pipeline_run_id];
            if (woStats[projectId]) {
              woStats[projectId].total++;
              if (wo.status === 'done') woStats[projectId].completed++;
              else if (wo.status === 'in_progress') woStats[projectId].in_progress++;
              else if (wo.status === 'failed') woStats[projectId].failed++;
            }
          }
        });

        // Merge data
        const projectsWithStats: ProjectWithStats[] = projectsData.map(p => ({
          ...p,
          stream_count: streamCounts[p.id] || 0,
          wo_total: woStats[p.id]?.total || 0,
          wo_completed: woStats[p.id]?.completed || 0,
          wo_in_progress: woStats[p.id]?.in_progress || 0,
          wo_failed: woStats[p.id]?.failed || 0,
          completion_pct: woStats[p.id]?.total ? 
            Math.round((woStats[p.id].completed / woStats[p.id].total) * 100) : 0,
        }));

        setProjects(projectsWithStats);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }

    fetchProjects();
  }, []);

  return { projects, loading, error };
}
