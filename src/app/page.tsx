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
  Plus,
  X,
  Globe,
  Tag,
} from "lucide-react";

interface Hit {
  keyword: string;
  title: string;
  asin: string;
  seller: string;
  sellerOrigin: string;
  price: string;
  url: string;
  category?: string;
  reason: string;
}

interface Report {
  campaignName: string;
  claimType: string;
  sellerScope: string;
  zipCode: string;
  keywords: string[];
  pages_crawled: number;
  total_products_checked: number;
  generatedAt: string;
  hits: Hit[];
}

export default function Home() {
  const [campaignName, setCampaignName] = useState("");
  const [keywords, setKeywords] = useState<string[]>([""]);
  const [pages, setPages] = useState("20");
  const [zipCode, setZipCode] = useState("10019");
  const [scanning, setScanning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => {
    setLogs((prev) => {
      const next = [...prev, msg];
      setTimeout(() => logsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      return next;
    });
  };

  const addKeyword = () => setKeywords((prev) => [...prev, ""]);
  const removeKeyword = (i: number) =>
    setKeywords((prev) => prev.filter((_, idx) => idx !== i));
  const updateKeyword = (i: number, val: string) =>
    setKeywords((prev) => prev.map((k, idx) => (idx === i ? val : k)));

  const validKeywords = keywords.map((k) => k.trim()).filter(Boolean);
  const canScan = validKeywords.length > 0 && !scanning;

  const handleScan = async () => {
    if (!canScan) return;
    setScanning(true);
    setLogs([]);
    setReport(null);
    setError(null);

    try {
      const resp = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignName: campaignName || "Unnamed Campaign",
          keywords: validKeywords,
          pages: parseInt(pages),
          zipCode: zipCode || "10019",
        }),
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
            else if (data.event === "keyword_start") addLog(`\n🔍 Scanning keyword: "${data.keyword}"`);
            else if (data.event === "progress") addLog(`   ${data.message}`);
            else if (data.event === "candidate") addLog(`🎯 ${data.message}`);
            else if (data.event === "keyword_done") addLog(`✅ ${data.message}`);
            else if (data.event === "done") {
              setReport(data.report);
              addLog(`\n🏁 Campaign complete! ${data.report.hits.length} total hit(s) found.`);
            } else if (data.event === "error") {
              setError(data.message);
              addLog(`❌ Error: ${data.message}`);
            }
          } catch {
            // ignore malformed lines
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

  const exportCSV = () => {
    if (!report || report.hits.length === 0) return;
    const q = (s: string) => `"${(s ?? "").replace(/"/g, '""')}"`;
    const headers = ["#", "Keyword", "Title", "ASIN", "Seller", "Seller Origin", "Price", "Category", "URL", "Reason"];
    const rows = report.hits.map((h, i) => [
      i + 1,
      q(h.keyword),
      q(h.title),
      h.asin,
      q(h.seller),
      q(h.sellerOrigin),
      h.price,
      q(h.category ?? ""),
      h.url,
      q(h.reason),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = (report.campaignName || "argos").replace(/\s+/g, "-").toLowerCase();
    a.download = `argos-${slug}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Group hits by keyword
  const hitsByKeyword = report?.hits.reduce((acc, hit) => {
    acc[hit.keyword] = acc[hit.keyword] ?? [];
    acc[hit.keyword].push(hit);
    return acc;
  }, {} as Record<string, Hit[]>) ?? {};

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
            <p className="text-xs text-slate-400">Amazon Counterfeit Detector — Trademark &amp; Copyright</p>
          </div>
          <Badge variant="outline" className="ml-auto border-slate-700 text-slate-400 text-xs">
            Asia Seller Scope
          </Badge>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-10 space-y-8">
        {/* Campaign Setup */}
        <Card className="bg-slate-900/60 border-slate-800 backdrop-blur">
          <CardHeader className="pb-2 pt-5 px-5">
            <CardTitle className="text-sm font-semibold text-slate-300">Campaign Setup</CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-6 space-y-5">
            {/* Campaign Name + Claim Type */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Campaign Name</label>
                <Input
                  placeholder="e.g. Godzilla Q1 2026"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-red-500/50"
                  disabled={scanning}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Claim Type</label>
                <div className="h-10 px-3 flex items-center rounded-md border border-slate-700 bg-slate-800/50 text-sm text-slate-400 gap-2">
                  <Tag className="w-3.5 h-3.5 text-red-400" />
                  Trademark &amp; Copyright
                </div>
              </div>
            </div>

            {/* Scope row */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Seller Scope</label>
                <div className="h-10 px-3 flex items-center rounded-md border border-slate-700 bg-slate-800/50 text-sm text-slate-400 gap-2">
                  <Globe className="w-3.5 h-3.5 text-blue-400" />
                  Asia-based sellers (excl. Japan)
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-slate-400">Ship-to ZIP Code</label>
                <Input
                  placeholder="10019"
                  value={zipCode}
                  onChange={(e) => setZipCode(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-red-500/50"
                  disabled={scanning}
                />
              </div>
            </div>

            <Separator className="bg-slate-800" />

            {/* Keywords */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <label className="text-xs text-slate-400">Keywords to Scan</label>
                <span className="text-xs text-slate-500">Exact word match, case-insensitive</span>
              </div>
              <div className="space-y-2">
                {keywords.map((kw, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      placeholder={`Keyword ${i + 1} — e.g. Godzilla, G0dzilla, Go-Dzilla`}
                      value={kw}
                      onChange={(e) => updateKeyword(i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !scanning) {
                          if (i === keywords.length - 1) addKeyword();
                        }
                      }}
                      className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-red-500/50"
                      disabled={scanning}
                    />
                    {keywords.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => removeKeyword(i)}
                        disabled={scanning}
                        className="text-slate-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button
                variant="ghost"
                onClick={addKeyword}
                disabled={scanning}
                className="text-slate-400 hover:text-white text-xs h-8 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add another keyword
              </Button>
            </div>

            <Separator className="bg-slate-800" />

            {/* Pages + Scan button */}
            <div className="flex items-center gap-4">
              <div className="space-y-1.5 w-36">
                <label className="text-xs text-slate-400">Pages per keyword</label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={pages}
                  onChange={(e) => setPages(e.target.value)}
                  className="bg-slate-800 border-slate-700 text-white text-center focus-visible:ring-red-500/50"
                  disabled={scanning}
                />
              </div>
              <div className="flex-1" />
              <Button
                onClick={handleScan}
                disabled={!canScan}
                className="bg-red-600 hover:bg-red-700 text-white px-8 h-10 cursor-pointer"
              >
                {scanning ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Search className="w-4 h-4 mr-2" />
                )}
                {scanning ? "Scanning..." : `Scan ${validKeywords.length > 0 ? `(${validKeywords.length} keyword${validKeywords.length > 1 ? "s" : ""})` : ""}`}
              </Button>
            </div>

            {/* Filter legend */}
            <div className="flex flex-wrap gap-4">
              {[
                { icon: Package, color: "text-green-400", label: "Skips Amazon-sold items" },
                { icon: Globe, color: "text-blue-400", label: "Asia-based sellers only (excl. Japan)" },
                { icon: AlertTriangle, color: "text-yellow-400", label: "Skips digital & media products" },
                { icon: ShieldAlert, color: "text-red-400", label: "Flags third-party + unknown origin (FBA)" },
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
              <div className="bg-slate-950 rounded-md p-3 max-h-64 overflow-y-auto font-mono text-xs space-y-0.5">
                {logs.map((log, i) => (
                  <div key={i} className={`leading-relaxed whitespace-pre-wrap ${log.startsWith("🎯") ? "text-yellow-300" : log.startsWith("✅") ? "text-green-400" : log.startsWith("❌") ? "text-red-400" : log.startsWith("🔍") ? "text-blue-300 font-semibold" : "text-slate-300"}`}>
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
          <div className="space-y-5">
            {/* Campaign summary */}
            <Card className="bg-slate-900/60 border-slate-700">
              <CardContent className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2 flex-1">
                    <div className="flex items-center gap-3">
                      {report.hits.length === 0 ? (
                        <ShieldCheck className="w-5 h-5 text-green-400" />
                      ) : (
                        <ShieldAlert className="w-5 h-5 text-red-400" />
                      )}
                      <span className="font-semibold text-lg">
                        {report.hits.length === 0
                          ? "No counterfeits found"
                          : `${report.hits.length} potential counterfeit${report.hits.length !== 1 ? "s" : ""} found`}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
                      <span>Campaign: <span className="text-white">{report.campaignName}</span></span>
                      <span>Claim: <span className="text-white">{report.claimType}</span></span>
                      <span>Scope: <span className="text-white">{report.sellerScope}</span></span>
                      <span>ZIP: <span className="text-white">{report.zipCode}</span></span>
                      <span>Keywords: <span className="text-white">{report.keywords.join(", ")}</span></span>
                      <span>Pages crawled: <span className="text-white">{report.pages_crawled}</span></span>
                      <span>Products checked: <span className="text-white">{report.total_products_checked}</span></span>
                    </div>
                  </div>
                  {report.hits.length > 0 && (
                    <Button
                      onClick={exportCSV}
                      variant="outline"
                      className="border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 cursor-pointer shrink-0"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Export CSV
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Hits grouped by keyword */}
            {report.hits.length > 0 ? (
              <div className="space-y-6">
                {Object.entries(hitsByKeyword).map(([kw, kwHits]) => (
                  <div key={kw} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge className="bg-slate-800 text-slate-200 border-slate-700 font-mono">
                        {kw}
                      </Badge>
                      <span className="text-xs text-slate-500">{kwHits.length} hit{kwHits.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="space-y-2">
                      {kwHits.map((hit, i) => (
                        <Card
                          key={hit.asin + i}
                          className="bg-slate-900/60 border-red-900/40 hover:border-red-700/60 transition-colors"
                        >
                          <CardContent className="px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0 space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge className="bg-red-900/40 text-red-300 border-red-800/50 text-[10px]">
                                    Flagged
                                  </Badge>
                                  <Badge
                                    className={`text-[10px] border ${
                                      hit.sellerOrigin.toLowerCase().includes("asia")
                                        ? "bg-orange-900/30 text-orange-300 border-orange-800/40"
                                        : "bg-slate-800 text-slate-400 border-slate-700"
                                    }`}
                                  >
                                    {hit.sellerOrigin}
                                  </Badge>
                                </div>
                                <p className="font-medium text-sm text-white leading-snug">{hit.title}</p>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                                  <span>Seller: <span className="text-yellow-300 font-medium">{hit.seller}</span></span>
                                  <span>ASIN: <span className="text-slate-300 font-mono">{hit.asin}</span></span>
                                  {hit.price && <span>Price: <span className="text-slate-300">{hit.price}</span></span>}
                                  {hit.category && <span className="truncate max-w-xs">Category: <span className="text-slate-300">{hit.category}</span></span>}
                                </div>
                                <p className="text-xs text-slate-500 italic">{hit.reason}</p>
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
                  </div>
                ))}
              </div>
            ) : (
              <Card className="bg-slate-900/60 border-green-900/40">
                <CardContent className="px-5 py-8 flex flex-col items-center text-center gap-3">
                  <ShieldCheck className="w-10 h-10 text-green-400" />
                  <p className="text-green-300 font-medium">Clean scan — no counterfeits detected</p>
                  <p className="text-xs text-slate-500">
                    All matching products are either sold by Amazon, are digital/media, or are from non-Asia sellers.
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

      <div className="border-t border-slate-800 mt-16">
        <div className="max-w-5xl mx-auto px-6 py-4 text-center text-xs text-slate-600">
          Project Argos — Trademark &amp; Copyright Infringement Detection · Built by Nap Solutions
        </div>
      </div>
    </div>
  );
}
