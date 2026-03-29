import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { TargetPropertyIngestPanel } from "@/components/admin/TargetPropertyIngestPanel";
import { toast } from "sonner";
import { Loader2, Database, RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";

interface IngestionLog {
  id: string;
  state: string;
  source: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  fetched_count: number;
  parsed_count: number;
  inserted_count: number;
  skipped_count: number;
  error_count: number;
  errors: any;
  config: any;
}

interface SourceStats {
  source: string;
  state: string;
  count: number;
}

export default function BuildingFootprintIngestion() {
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [sourceStats, setSourceStats] = useState<SourceStats[]>([]);
  const [logs, setLogs] = useState<IngestionLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [selectedState, setSelectedState] = useState("NJ");

  const loadStats = async () => {
    setLoading(true);
    try {
      // Get total count
      const { count } = await supabase.from("building_footprints").select("*", { count: "exact", head: true });
      setTotalCount(count ?? 0);

      // Get by source/state via raw query workaround
      const { data: allRows } = await supabase.from("building_footprints").select("source, state").limit(1000);
      if (allRows) {
        const map = new Map<string, number>();
        allRows.forEach((r: any) => {
          const key = `${r.source}|${r.state}`;
          map.set(key, (map.get(key) || 0) + 1);
        });
        setSourceStats(Array.from(map.entries()).map(([k, c]) => {
          const [source, state] = k.split("|");
          return { source, state, count: c };
        }));
      }

      // Get recent logs
      const { data: logData } = await supabase
        .from("building_footprint_ingestion_logs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(10);
      setLogs((logData as IngestionLog[]) || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  useEffect(() => { loadStats(); }, []);

  const runTestIngestion = async () => {
    setIngesting(true);
    setTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("ingest-building-footprints", {
        body: { state: selectedState, test_mode: true, test_limit: 25, id_batch_size: 25 },
      });
      if (error) throw new Error(error.message);
      setTestResult(data);
      toast.success(`Test ingestion: ${data.inserted_count} rows inserted`);
      await loadStats();
    } catch (err: any) {
      toast.error(`Ingestion failed: ${err.message}`);
      setTestResult({ error: err.message });
    }
    setIngesting(false);
  };

  const runBatchIngestion = async () => {
    setIngesting(true);
    setTestResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("ingest-building-footprints", {
        body: { state: selectedState, test_mode: false, limit: 2000, id_batch_size: 200 },
      });
      if (error) throw new Error(error.message);
      setTestResult(data);
      const cellsInfo = data.grid_cells_processed ? ` (${data.grid_cells_processed}/${data.grid_cells_total} cells in ${data.elapsed_seconds}s)` : "";
      toast.success(`Batch ingestion: ${data.inserted_count} rows inserted${cellsInfo}`);
      await loadStats();
    } catch (err: any) {
      toast.error(`Ingestion failed: ${err.message}`);
      setTestResult({ error: err.message });
    }
    setIngesting(false);
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Building Footprint Ingestion</h1>
        <Button variant="outline" size="sm" onClick={loadStats} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Footprints</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {totalCount === null ? "..." : totalCount.toLocaleString()}
            </div>
            {totalCount === 0 && (
              <p className="text-sm text-destructive mt-1 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Table is empty — run ingestion
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">By Source / State</CardTitle>
          </CardHeader>
          <CardContent>
            {sourceStats.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data</p>
            ) : (
              <div className="space-y-1">
                {sourceStats.map((s, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span>{s.source} / {s.state}</span>
                    <Badge variant="secondary">{s.count.toLocaleString()}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Latest Ingestion</CardTitle>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runs yet</p>
            ) : (
              <div className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  {logs[0].status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : logs[0].status === "failed" ? (
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                  ) : (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  <Badge variant={logs[0].status === "completed" ? "default" : "destructive"}>
                    {logs[0].status}
                  </Badge>
                </div>
                <p>{new Date(logs[0].started_at).toLocaleString()}</p>
                <p>Inserted: {logs[0].inserted_count}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run Ingestion</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3 mb-2">
            <Label className="text-sm font-medium">State:</Label>
            <select
              value={selectedState}
              onChange={(e) => setSelectedState(e.target.value)}
              className="border rounded-md px-3 py-1.5 text-sm bg-background"
            >
              <option value="NJ">New Jersey (NJ)</option>
              <option value="PA">Pennsylvania (PA)</option>
            </select>
          </div>
          <div className="flex gap-3">
            <Button onClick={runTestIngestion} disabled={ingesting} variant="outline">
              {ingesting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Database className="h-4 w-4 mr-2" />}
              Test Mode (25 rows, {selectedState})
            </Button>
            <Button onClick={runBatchIngestion} disabled={ingesting}>
              {ingesting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Database className="h-4 w-4 mr-2" />}
              Batch Ingest (2,000 rows, {selectedState})
            </Button>
          </div>

          {testResult && (
            <Alert variant={testResult.error ? "destructive" : "default"}>
              <AlertDescription>
                <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-48">
                  {JSON.stringify(testResult, null, 2)}
                </pre>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <TargetPropertyIngestPanel onComplete={loadStats} />

      {/* Ingestion History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Ingestion History</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No ingestion runs found</p>
          ) : (
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left p-2">Time</th>
                    <th className="text-left p-2">State</th>
                    <th className="text-left p-2">Status</th>
                    <th className="text-right p-2">Fetched</th>
                    <th className="text-right p-2">Parsed</th>
                    <th className="text-right p-2">Inserted</th>
                    <th className="text-right p-2">Skipped</th>
                    <th className="text-right p-2">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b">
                      <td className="p-2">{new Date(log.started_at).toLocaleString()}</td>
                      <td className="p-2">{log.state}</td>
                      <td className="p-2">
                        <Badge variant={log.status === "completed" ? "default" : log.status === "failed" ? "destructive" : "secondary"}>
                          {log.status}
                        </Badge>
                      </td>
                      <td className="p-2 text-right">{log.fetched_count}</td>
                      <td className="p-2 text-right">{log.parsed_count}</td>
                      <td className="p-2 text-right">{log.inserted_count}</td>
                      <td className="p-2 text-right">{log.skipped_count}</td>
                      <td className="p-2 text-right">{log.error_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
