import React, { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, CheckCircle, TrendingDown, TrendingUp } from 'lucide-react';

interface RegressionRun {
  id: string;
  suite_definition_id: string;
  work_order_id: string;
  run_at: string;
  score: number;
  baseline_score: number;
  delta_pct: number;
  status: string;
  execution_time_sec: number;
  metadata: any;
}

interface SuiteDefinition {
  id: string;
  suite_name: string;
  description: string;
  canonical_wo_template: any;
  baseline_score: number;
  baseline_set_at: string;
  active: boolean;
}

export default function RegressionDashboard() {
  const [runs, setRuns] = useState<RegressionRun[]>([]);
  const [suites, setSuites] = useState<SuiteDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      
      // Load suite definitions
      const { data: suitesData, error: suitesError } = await supabase
        .from('regression_suite_definitions')
        .select('*')
        .order('suite_name');
      
      if (suitesError) throw suitesError;
      
      // Load recent runs (last 7 days)
      const { data: runsData, error: runsError } = await supabase
        .from('regression_test_runs')
        .select('*')
        .gte('run_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
        .order('run_at', { ascending: false });
      
      if (runsError) throw runsError;
      
      setSuites(suitesData || []);
      setRuns(runsData || []);
      setError(null);
    } catch (err) {
      console.error('Error loading regression data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pass':
        return <Badge className="bg-green-500"><CheckCircle className="w-3 h-3 mr-1" />Pass</Badge>;
      case 'fail':
        return <Badge className="bg-red-500"><AlertCircle className="w-3 h-3 mr-1" />Fail</Badge>;
      case 'running':
        return <Badge className="bg-blue-500">Running</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getDeltaBadge = (deltaPct: number) => {
    if (deltaPct === 0) return <Badge variant="outline">No Change</Badge>;
    if (deltaPct > 0) {
      return (
        <Badge className="bg-green-500">
          <TrendingUp className="w-3 h-3 mr-1" />
          +{deltaPct.toFixed(1)}%
        </Badge>
      );
    }
    return (
      <Badge className="bg-red-500">
        <TrendingDown className="w-3 h-3 mr-1" />
        {deltaPct.toFixed(1)}%
      </Badge>
    );
  };

  const getRunsForSuite = (suiteId: string) => {
    return runs.filter(r => r.suite_definition_id === suiteId);
  };

  const getLatestRun = (suiteId: string) => {
    const suiteRuns = getRunsForSuite(suiteId);
    return suiteRuns.length > 0 ? suiteRuns[0] : null;
  };

  const hasRecentFailures = () => {
    return runs.some(r => r.status === 'fail' && Math.abs(r.delta_pct) > 10);
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <div className="text-center">Loading regression data...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Regression Test Suite</h1>
        <Badge variant={hasRecentFailures() ? "destructive" : "default"}>
          {runs.filter(r => r.status === 'fail').length} Recent Failures
        </Badge>
      </div>

      {hasRecentFailures() && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            One or more regression tests show &gt;10% score degradation from baseline.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6">
        {suites.map(suite => {
          const latestRun = getLatestRun(suite.id);
          const suiteRuns = getRunsForSuite(suite.id);
          
          return (
            <Card key={suite.id}>
              <CardHeader>
                <div className="flex justify-between items-start">
                  <div>
                    <CardTitle>{suite.suite_name}</CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {suite.description}
                    </p>
                  </div>
                  <Badge variant={suite.active ? "default" : "secondary"}>
                    {suite.active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-4 gap-4">
                    <div>
                      <div className="text-sm text-muted-foreground">Baseline Score</div>
                      <div className="text-2xl font-bold">{suite.baseline_score}/100</div>
                    </div>
                    {latestRun && (
                      <>
                        <div>
                          <div className="text-sm text-muted-foreground">Latest Score</div>
                          <div className="text-2xl font-bold">{latestRun.score}/100</div>
                        </div>
                        <div>
                          <div className="text-sm text-muted-foreground">Delta</div>
                          <div className="mt-1">{getDeltaBadge(latestRun.delta_pct)}</div>
                        </div>
                        <div>
                          <div className="text-sm text-muted-foreground">Status</div>
                          <div className="mt-1">{getStatusBadge(latestRun.status)}</div>
                        </div>
                      </>
                    )}
                  </div>

                  {suiteRuns.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold mb-2">Recent Runs (Last 7 Days)</h4>
                      <div className="space-y-2">
                        {suiteRuns.slice(0, 5).map(run => (
                          <div key={run.id} className="flex items-center justify-between text-sm border-l-2 border-border pl-3 py-1">
                            <div className="flex items-center gap-3">
                              <span className="text-muted-foreground">
                                {new Date(run.run_at).toLocaleString()}
                              </span>
                              <span className="font-mono">{run.work_order_id}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="font-semibold">{run.score}/100</span>
                              {getDeltaBadge(run.delta_pct)}
                              {getStatusBadge(run.status)}
                              <span className="text-muted-foreground">
                                {run.execution_time_sec}s
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {suiteRuns.length === 0 && (
                    <div className="text-center text-muted-foreground py-4">
                      No runs in the last 7 days
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}

        {suites.length === 0 && (
          <Card>
            <CardContent className="text-center py-8 text-muted-foreground">
              No regression test suites defined yet.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
