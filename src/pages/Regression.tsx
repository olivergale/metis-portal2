import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle, TrendingDown, TrendingUp } from 'lucide-react';

interface RegressionSuite {
  id: string;
  suite_name: string;
  description: string;
  canonical_wo_slug: string;
  baseline_score: number | null;
  active: boolean;
}

interface RegressionRun {
  id: string;
  run_at: string;
  total_suites: number;
  passed: number;
  failed: number;
  status: string;
}

interface RegressionResult {
  id: string;
  suite_id: string;
  suite_name: string;
  test_wo_slug: string;
  actual_score: number;
  baseline_score: number;
  score_delta: number;
  passed: boolean;
}

export default function Regression() {
  const [suites, setSuites] = useState<RegressionSuite[]>([]);
  const [runs, setRuns] = useState<RegressionRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [results, setResults] = useState<RegressionResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (selectedRun) {
      loadResults(selectedRun);
    }
  }, [selectedRun]);

  async function loadData() {
    setLoading(true);
    try {
      // Load suites
      const { data: suitesData } = await supabase
        .from('regression_suite_definitions')
        .select('*')
        .eq('active', true)
        .order('suite_name');
      
      setSuites(suitesData || []);

      // Load recent runs
      const { data: runsData } = await supabase
        .from('regression_runs')
        .select('*')
        .order('run_at', { ascending: false })
        .limit(10);
      
      setRuns(runsData || []);
      
      // Auto-select most recent run
      if (runsData && runsData.length > 0) {
        setSelectedRun(runsData[0].id);
      }
    } catch (error) {
      console.error('Error loading regression data:', error);
    } finally {
      setLoading(false);
    }
  }

  async function loadResults(runId: string) {
    try {
      const { data } = await supabase
        .from('regression_run_results')
        .select(`
          *,
          regression_suite_definitions!inner(suite_name)
        `)
        .eq('run_id', runId)
        .order('suite_name');
      
      const formattedResults = (data || []).map(r => ({
        id: r.id,
        suite_id: r.suite_id,
        suite_name: r.regression_suite_definitions.suite_name,
        test_wo_slug: r.test_wo_slug,
        actual_score: r.actual_score,
        baseline_score: r.baseline_score,
        score_delta: r.score_delta,
        passed: r.passed
      }));
      
      setResults(formattedResults);
    } catch (error) {
      console.error('Error loading results:', error);
    }
  }

  async function triggerManualRun() {
    try {
      const { error } = await supabase.rpc('run_regression_suite');
      if (error) throw error;
      
      // Reload data after a short delay
      setTimeout(() => loadData(), 2000);
    } catch (error) {
      console.error('Error triggering manual run:', error);
    }
  }

  if (loading) {
    return <div className="p-8">Loading regression data...</div>;
  }

  const latestRun = runs[0];

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Regression Suite</h1>
          <p className="text-muted-foreground mt-1">
            Automated nightly testing of canonical work order patterns
          </p>
        </div>
        <Button onClick={triggerManualRun}>
          Run Manual Test
        </Button>
      </div>

      {/* Latest Run Summary */}
      {latestRun && (
        <Card>
          <CardHeader>
            <CardTitle>Latest Run</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">Run Time</div>
                <div className="text-lg font-semibold">
                  {new Date(latestRun.run_at).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Total Suites</div>
                <div className="text-lg font-semibold">{latestRun.total_suites}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Passed</div>
                <div className="text-lg font-semibold text-green-600">
                  {latestRun.passed}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Failed</div>
                <div className="text-lg font-semibold text-red-600">
                  {latestRun.failed}
                </div>
              </div>
            </div>
            <div className="mt-4">
              <Badge variant={latestRun.status === 'completed' ? 'default' : 'destructive'}>
                {latestRun.status}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Canonical Suites */}
      <Card>
        <CardHeader>
          <CardTitle>Canonical Work Orders ({suites.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {suites.map(suite => (
              <div key={suite.id} className="flex items-center justify-between p-3 border rounded">
                <div className="flex-1">
                  <div className="font-medium">{suite.suite_name}</div>
                  <div className="text-sm text-muted-foreground">{suite.description}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Pattern: {suite.canonical_wo_slug}
                  </div>
                </div>
                {suite.baseline_score !== null && (
                  <div className="text-sm">
                    Baseline: <span className="font-semibold">{suite.baseline_score}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Run History */}
      <Card>
        <CardHeader>
          <CardTitle>Run History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {runs.map(run => (
              <div
                key={run.id}
                className={`flex items-center justify-between p-3 border rounded cursor-pointer hover:bg-accent ${
                  selectedRun === run.id ? 'border-primary bg-accent' : ''
                }`}
                onClick={() => setSelectedRun(run.id)}
              >
                <div>
                  <div className="font-medium">
                    {new Date(run.run_at).toLocaleString()}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {run.total_suites} suites • {run.passed} passed • {run.failed} failed
                  </div>
                </div>
                <Badge variant={run.status === 'completed' ? 'default' : 'destructive'}>
                  {run.status}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Results Detail */}
      {selectedRun && results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Test Results</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {results.map(result => (
                <div
                  key={result.id}
                  className={`flex items-center justify-between p-3 border rounded ${
                    result.passed ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    {result.passed ? (
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-red-600" />
                    )}
                    <div>
                      <div className="font-medium">{result.suite_name}</div>
                      <div className="text-sm text-muted-foreground">
                        Test WO: {result.test_wo_slug}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm text-muted-foreground">Score</div>
                      <div className="font-semibold">
                        {result.actual_score} / {result.baseline_score}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {result.score_delta < 0 ? (
                        <>
                          <TrendingDown className="h-4 w-4 text-red-600" />
                          <span className="text-red-600 font-semibold">
                            {result.score_delta}%
                          </span>
                        </>
                      ) : (
                        <>
                          <TrendingUp className="h-4 w-4 text-green-600" />
                          <span className="text-green-600 font-semibold">
                            +{result.score_delta}%
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
