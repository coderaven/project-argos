"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Search,
  ShieldAlert,
  ShieldCheck,
  Loader2,
  ExternalLink,
  Eye,
  Package,
  AlertTriangle,
  Download,
} from "lucide-react";

interface Hit {
  title: string;
  asin: string;
  seller: string;
  price: string | number;
  url: string;
  category?: string;
  reason: string;
}

interface Report {
  keyword: string;
  pages_crawled: number;
  total_products_checked: number;
  hits: Hit[];
}

export default function Home() {
  const [keyword, setKeyword] = useState("");
  const [pages, setPages] = useState("20");
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const exportCSV = () => {
    if (!report || report.hits.length === 0) return;
    const headers = ["#", "Title", "ASIN", "Seller", "Price", "Category", "URL"];
    const rows = report.hits.map((h, i) => [
      i + 1,
      `"${h.title.replace(/"/g, '""')}"`,
      h.asin,
      `"${h.seller.replace(/"/g, '""')}"`,
      h.price,
      `"${(h.category ?? "").replace(/"/g, '""')}"`,
      h.url,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `argos-${report.keyword.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const addLog = (msg: string) => {
    setLogs((prev) => {
      const next = [...prev, msg];
      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      return next;
    });
  };

  const handleScan = async () => {
    if (!keyword.trim()) return;
    setScanning(true);
    setLogs([]);
    setReport(null);
    setError(null);

    addLog(`🦅 Project Argos starting scan for "${keyword}" (${pages} pages)...`);

    try {
      const resp = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: keyword.trim(), pages: parseInt(pages) }),
      });

      if (!resp.body) throw new Error("No response body");

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.event === "status") addLog(`ℹ️  ${data.message}`);
            else if (data.event === "progress") addLog(`   ${data.message}`);
            else if (data.event === "candidate") addLog(`🎯 ${data.message}`);
            else if (data.event === "done") {
              setReport(data.report);
              addLog(`✅ Scan complete! ${data.report.hits.length} hit(s) found.`);
            } else if (data.event === "error") {
              setError(data.message);
              addLog(`❌ Error: ${data.message}`);
            }
          } catch {
            // ignore malformed SSE lines
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      addLog(`❌ Error: ${msg}`);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Header */}
      <div className="border-b border-slate-800 bg-slate-900/50 backdrop-blur">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20">
            <Eye className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">Project Argos</h1>
            <p className="text-xs text-slate-400">Amazon Counterfeit Detector</p>
          </div>
          <Badge variant="outline" className="ml-auto border-slate-700 text-slate-400 text-xs">
            AI-Powered
          </Badge>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        {/* Search card */}
        <Card className="bg-slate-900/60 border-slate-800 backdrop-blur">
          <CardContent className="pt-6 space-y-4">
            <div>
              <p className="text-sm text-slate-400 mb-4">
                Enter a brand or product keyword. Argos will crawl Amazon and flag physical
                products sold by third-party sellers — potential counterfeits.
              </p>
              <div className="flex gap-3">
                <div className="flex-1">
                  <Input
                    placeholder="e.g. Godzilla, Nike, Sony..."
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !scanning && handleScan()}
                    className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-red-500/50"
                    disabled={scanning}
                  />
                </div>
                <div className="w-28">
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={pages}
                    onChange={(e) => setPages(e.target.value)}
                    className="bg-slate-800 border-slate-700 text-white text-center focus-visible:ring-red-500/50"
                    disabled={scanning}
                    placeholder="Pages"
                  />
                </div>
                <Button
                  onClick={handleScan}
                  disabled={scanning || !keyword.trim()}
                  className="bg-red-600 hover:bg-red-700 text-white px-6 cursor-pointer"
                >
                  {scanning ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Search className="w-4 h-4" />
                  )}
                  <span className="ml-2">{scanning ? "Scanning..." : "Scan"}</span>
                </Button>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Pages to crawl (max 20) · Each page ~15–20 products · Keyword match is exact word, case-insensitive
              </p>
            </div>

            {/* Filter legend */}
            <div className="flex flex-wrap gap-4 pt-2">
              {[
                { icon: Package, color: "text-green-400", label: "Skips Amazon-sold items" },
                { icon: AlertTriangle, color: "text-yellow-400", label: "Skips digital products" },
                { icon: ShieldAlert, color: "text-red-400", label: "Flags third-party physical sellers" },
              ].map(({ icon: Icon, color, label }) => (
                <div key={label} className="flex items-center gap-2 text-xs text-slate-400">
                  <Icon className={`w-3.5 h-3.5 ${color}`} />
                  {label}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Live log */}
        {logs.length > 0 && (
          <Card className="bg-slate-900/60 border-slate-800">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-mono text-slate-400 flex items-center gap-2">
                {scanning && <Loader2 className="w-3 h-3 animate-spin text-red-400" />}
                Live Log
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="bg-slate-950 rounded-md p-3 max-h-56 overflow-y-auto font-mono text-xs space-y-1">
                {logs.map((log, i) => (
                  <div key={i} className="text-slate-300 leading-relaxed">
                    {log}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {report && (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="flex items-center gap-4 flex-wrap justify-between">
              <div className="flex items-center gap-2">
                {report.hits.length === 0 ? (
                  <ShieldCheck className="w-5 h-5 text-green-400" />
                ) : (
                  <ShieldAlert className="w-5 h-5 text-red-400" />
                )}
                <span className="font-semibold">
                  {report.hits.length === 0
                    ? "No counterfeits found"
                    : `${report.hits.length} potential counterfeit${report.hits.length !== 1 ? "s" : ""} found`}
                </span>
              </div>
              <Separator orientation="vertical" className="h-4 bg-slate-700" />
              <span className="text-sm text-slate-400">
                Keyword: <span className="text-white font-medium">&ldquo;{report.keyword}&rdquo;</span>
              </span>
              <span className="text-sm text-slate-400">
                Pages crawled: <span className="text-white font-medium">{report.pages_crawled}</span>
              </span>
              <span className="text-sm text-slate-400">
                Products checked: <span className="text-white font-medium">{report.total_products_checked}</span>
              </span>
              {report.hits.length > 0 && (
                <Button
                  onClick={exportCSV}
                  variant="outline"
                  className="ml-auto border-slate-700 text-slate-300 hover:text-white hover:border-slate-500 cursor-pointer"
                >
                  <Download className="w-4 h-4 mr-2" />
                  Export CSV
                </Button>
              )}
            </div>

            {/* Hit cards */}
            {report.hits.length > 0 ? (
              <div className="space-y-3">
                {report.hits.map((hit, i) => (
                  <Card
                    key={hit.asin}
                    className="bg-slate-900/60 border-red-900/40 hover:border-red-700/60 transition-colors"
                  >
                    <CardContent className="px-5 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0 space-y-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-500 font-mono">#{i + 1}</span>
                            <Badge className="bg-red-900/40 text-red-300 border-red-800/50 text-[10px]">
                              Flagged
                            </Badge>
                          </div>
                          <p className="font-medium text-sm text-white leading-snug">{hit.title}</p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                            <span>
                              Seller:{" "}
                              <span className="text-yellow-300 font-medium">{hit.seller || "Unknown"}</span>
                            </span>
                            <span>
                              ASIN:{" "}
                              <span className="text-slate-300 font-mono">{hit.asin}</span>
                            </span>
                            {hit.price && (
                              <span>
                                Price:{" "}
                                <span className="text-slate-300">
                                  {typeof hit.price === "number" ? `$${hit.price}` : hit.price}
                                </span>
                              </span>
                            )}
                          </div>
                          {hit.reason && (
                            <p className="text-xs text-slate-500 italic">{hit.reason}</p>
                          )}
                        </div>
                        {hit.url && (
                          <a
                            href={hit.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 p-2 rounded-md bg-slate-800 hover:bg-slate-700 transition-colors text-slate-400 hover:text-white"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <Card className="bg-slate-900/60 border-green-900/40">
                <CardContent className="px-5 py-8 flex flex-col items-center text-center gap-3">
                  <ShieldCheck className="w-10 h-10 text-green-400" />
                  <p className="text-green-300 font-medium">Clean scan — no counterfeits detected</p>
                  <p className="text-xs text-slate-500">
                    All products with this keyword are either sold by Amazon directly or are digital products.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {error && !report && (
          <Card className="bg-slate-900/60 border-red-900/40">
            <CardContent className="px-5 py-4 flex items-center gap-3 text-red-300">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <p className="text-sm">{error}</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-slate-800 mt-16">
        <div className="max-w-5xl mx-auto px-6 py-4 text-center text-xs text-slate-600">
          Project Argos — Powered by Oxylabs + OpenAI · Built by Nap Solutions
        </div>
      </div>
    </div>
  );
}
