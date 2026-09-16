"use client";

import { useState } from "react";
import type { Topic, ExtractionResult } from "@/lib/extract";

type TopicRow = Topic & { status: "pending" | "success" | "failed" };

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slug(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function buildIndexCsv(rows: TopicRow[], results: Record<string, ExtractionResult>) {
  const header = "Topic,Category,File Name,Source URL,Source Updated,Extraction Date,Status";
  const lines = rows.map((r) => {
    const res = results[r.title];
    const fields = [
      r.title,
      r.category,
      `${slug(r.title)}.md`,
      r.url,
      res?.sourceUpdated ?? "",
      res?.extractedAt ?? "",
      res?.status ?? "pending",
    ];
    return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",");
  });
  return [header, ...lines].join("\n");
}

type UpdateReport = {
  unchanged: number;
  updated: number;
  brandNew: number;
  failed: number;
  details: string[];
};

export default function Home() {
  const [categoriesInput, setCategoriesInput] = useState(
    "Respiratory diseases, Heart diseases"
  );
  const [topics, setTopics] = useState<TopicRow[]>([]);
  const [results, setResults] = useState<Record<string, ExtractionResult>>({});
  const [prevHashes, setPrevHashes] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [updateReport, setUpdateReport] = useState<UpdateReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDiscover() {
    setError(null);
    setDiscovering(true);
    setResults({});
    setPrevHashes({});
    setUpdateReport(null);
    setSelected(null);
    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: categoriesInput, perCategoryLimit: 2, totalLimit: 3 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "discovery failed");
      setTopics(data.topics.map((t: Topic) => ({ ...t, status: "pending" as const })));
    } catch (e) {
      setError(e instanceof Error ? e.message : "discovery failed");
    } finally {
      setDiscovering(false);
    }
  }

  async function handleExtractAll() {
    setExtracting(true);
    setError(null);
    const newResults: Record<string, ExtractionResult> = {};
    const newHashes: Record<string, string> = {};
    for (const t of topics) {
      try {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: { title: t.title, url: t.url, category: t.category } }),
        });
        const data: ExtractionResult = await res.json();
        newResults[t.title] = data;
        if (data.contentHash) newHashes[t.title] = data.contentHash;
        setTopics((prev) =>
          prev.map((p) => (p.title === t.title ? { ...p, status: data.status } : p))
        );
      } catch {
        newResults[t.title] = {
          topic: t.title,
          sourceUrl: t.url,
          category: t.category,
          sourceUpdated: null,
          extractedAt: new Date().toISOString(),
          status: "failed",
          failureReason: "network error",
          checks: { headingsPreserved: false, listsPreserved: false, tablesDetected: false, metadataExtracted: false },
          warnings: [],
        };
        setTopics((prev) => prev.map((p) => (p.title === t.title ? { ...p, status: "failed" } : p)));
      }
    }
    setResults(newResults);
    setPrevHashes(newHashes);
    setExtracting(false);
    const firstOk = topics.find((t) => newResults[t.title]?.status === "success");
    if (firstOk) setSelected(firstOk.title);
  }

  async function handleRecheck() {
    setRechecking(true);
    setError(null);
    try {
      const discRes = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categories: categoriesInput, perCategoryLimit: 3, totalLimit: 6 }),
      });
      const discData = await discRes.json();
      const knownTitles = new Set(topics.map((t) => t.title));
      const brandNew: Topic[] = (discData.topics ?? []).filter((t: Topic) => !knownTitles.has(t.title));

      let unchanged = 0;
      let updated = 0;
      let failed = 0;
      const details: string[] = [];

      for (const t of topics) {
        const res = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: { title: t.title, url: t.url, category: t.category } }),
        });
        const data: ExtractionResult = await res.json();
        if (data.status === "failed") {
          failed++;
          details.push(`✕ ${t.title}: ${data.failureReason ?? "extraction failed"}`);
          continue;
        }
        const oldHash = prevHashes[t.title];
        if (oldHash && data.contentHash === oldHash) {
          unchanged++;
        } else {
          updated++;
          details.push(`↻ ${t.title}: content changed since last extraction`);
        }
      }
      for (const t of brandNew) {
        details.push(`+ ${t.title}: new topic found in ${t.category}`);
      }

      setUpdateReport({ unchanged, updated, brandNew: brandNew.length, failed, details });
    } catch (e) {
      setError(e instanceof Error ? e.message : "re-check failed");
    } finally {
      setRechecking(false);
    }
  }

  const succeeded = topics.filter((t) => results[t.title]?.status === "success");
  const failedTopics = topics.filter((t) => results[t.title]?.status === "failed");
  const categoryCount = new Set(topics.map((t) => t.category)).size;
  const selectedResult = selected ? results[selected] : null;
  const allExtracted = topics.length > 0 && topics.every((t) => results[t.title]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <div className="max-w-4xl mx-auto px-4 py-10">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Clinical Content Extractor</h1>
          <p className="text-sm text-slate-500 mt-1">
            Structured extraction proof of concept — topic discovery, category mapping,
            HTML→Markdown conversion with heading/list/table preservation, metadata, and
            change detection. Demonstrated here against Wikipedia medical articles as a
            public, permissively-licensed stand-in for a client&apos;s content library.
          </p>
        </header>

        <div className="border border-slate-200 rounded-lg bg-white p-4 mb-6">
          <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
            Source categories (comma-separated)
          </label>
          <div className="flex gap-2">
            <input
              value={categoriesInput}
              onChange={(e) => setCategoriesInput(e.target.value)}
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              placeholder="Respiratory diseases, Heart diseases"
            />
            <button
              onClick={handleDiscover}
              disabled={discovering}
              className="bg-indigo-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {discovering ? "Discovering…" : "Discover Topics"}
            </button>
          </div>
        </div>

        {error && (
          <div className="border border-rose-200 bg-rose-50 text-rose-700 text-sm rounded-lg px-4 py-3 mb-6">
            {error}
          </div>
        )}

        {topics.length > 0 && (
          <div className="border border-slate-200 rounded-lg bg-white p-4 mb-6">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-slate-600">
                Discovered: <span className="font-semibold text-slate-800">{topics.length}</span>{" "}
                topics &nbsp;·&nbsp; Categories:{" "}
                <span className="font-semibold text-slate-800">{categoryCount}</span>
              </p>
              <button
                onClick={handleExtractAll}
                disabled={extracting}
                className="bg-emerald-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {extracting ? "Extracting…" : "Extract All"}
              </button>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 uppercase text-xs">
                  <th className="py-1.5">Topic</th>
                  <th className="py-1.5">Category</th>
                  <th className="py-1.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {topics.map((t) => (
                  <tr
                    key={t.title}
                    onClick={() => results[t.title] && setSelected(t.title)}
                    className={`cursor-pointer ${selected === t.title ? "bg-indigo-50" : "hover:bg-slate-50"}`}
                  >
                    <td className="py-2 text-slate-800">{t.title}</td>
                    <td className="py-2 text-slate-500">{t.category}</td>
                    <td className="py-2">
                      {t.status === "pending" && <span className="text-slate-400">pending</span>}
                      {t.status === "success" && <span className="text-emerald-600 font-medium">✓</span>}
                      {t.status === "failed" && <span className="text-rose-600 font-medium">✕</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selectedResult && (
          <div className="border border-slate-200 rounded-lg bg-white overflow-hidden mb-6">
            <div className="px-4 py-3 border-b border-slate-100">
              <h2 className="font-semibold text-slate-800">Extraction Preview</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Topic: {selectedResult.topic} &nbsp;·&nbsp; Category: {selectedResult.category}
              </p>
            </div>
            {selectedResult.status === "success" ? (
              <>
                <pre className="px-4 py-3 text-xs text-slate-700 whitespace-pre-wrap max-h-96 overflow-y-auto bg-slate-50 border-b border-slate-100">
                  {showJson ? JSON.stringify(selectedResult, null, 2) : selectedResult.markdown}
                </pre>
                <div className="px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-xs border-b border-slate-100">
                  {[
                    ["Headings preserved", selectedResult.checks.headingsPreserved],
                    ["Lists preserved", selectedResult.checks.listsPreserved],
                    ["Tables detected", selectedResult.checks.tablesDetected],
                    ["Metadata extracted", selectedResult.checks.metadataExtracted],
                  ].map(([label, ok]) => (
                    <span key={label as string} className={ok ? "text-emerald-600" : "text-rose-500"}>
                      {ok ? "✓" : "✕"} {label as string}
                    </span>
                  ))}
                </div>
                <div className="px-4 py-3 flex gap-2">
                  <button
                    onClick={() =>
                      downloadBlob(`${slug(selectedResult.topic)}.md`, selectedResult.markdown ?? "", "text/markdown")
                    }
                    className="text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50"
                  >
                    Download .md
                  </button>
                  <button
                    onClick={() => setShowJson((s) => !s)}
                    className="text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50"
                  >
                    {showJson ? "View Markdown" : "View JSON"}
                  </button>
                </div>
              </>
            ) : (
              <p className="px-4 py-3 text-sm text-rose-600">
                Extraction failed: {selectedResult.failureReason}
              </p>
            )}
          </div>
        )}

        {allExtracted && (
          <div className="border border-slate-200 rounded-lg bg-white p-4 mb-6">
            <h2 className="font-semibold text-slate-800 mb-2">Extraction Report</h2>
            <p className="text-sm text-slate-600">
              {topics.length} topics discovered &nbsp;·&nbsp;{" "}
              <span className="text-emerald-600 font-medium">{succeeded.length} successfully extracted</span>
              &nbsp;·&nbsp;{" "}
              <span className={failedTopics.length ? "text-rose-600 font-medium" : "text-slate-400"}>
                {failedTopics.length} failed
              </span>
            </p>
            {failedTopics.length > 0 && (
              <div className="mt-2 text-sm">
                <p className="text-rose-600 font-medium">Failed:</p>
                <ul className="list-disc pl-5 text-slate-600">
                  {failedTopics.map((t) => (
                    <li key={t.title}>
                      {t.title} — {results[t.title]?.failureReason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {succeeded.some((t) => (results[t.title]?.warnings.length ?? 0) > 0) && (
              <div className="mt-2 text-sm">
                <p className="text-amber-600 font-medium">Warnings:</p>
                <ul className="list-disc pl-5 text-slate-600">
                  {succeeded.flatMap((t) => results[t.title]?.warnings.map((w, i) => <li key={t.title + i}>{w}</li>) ?? [])}
                </ul>
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => downloadBlob("index.csv", buildIndexCsv(topics, results), "text/csv")}
                className="text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50"
              >
                Download index.csv
              </button>
              <button
                onClick={handleRecheck}
                disabled={rechecking}
                className="text-xs border border-slate-300 rounded px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
              >
                {rechecking ? "Checking…" : "Re-check for Updates"}
              </button>
            </div>
          </div>
        )}

        {updateReport && (
          <div className="border border-slate-200 rounded-lg bg-white p-4">
            <h2 className="font-semibold text-slate-800 mb-2">Update Report</h2>
            <p className="text-sm text-slate-600">
              <span className="text-slate-500">✓ {updateReport.unchanged} unchanged</span>
              &nbsp;·&nbsp;
              <span className="text-amber-600">↻ {updateReport.updated} updated</span>
              &nbsp;·&nbsp;
              <span className="text-indigo-600">+ {updateReport.brandNew} new</span>
              &nbsp;·&nbsp;
              <span className={updateReport.failed ? "text-rose-600" : "text-slate-400"}>
                ✕ {updateReport.failed} extraction failure{updateReport.failed === 1 ? "" : "s"}
              </span>
            </p>
            {updateReport.details.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-slate-600 mt-2">
                {updateReport.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            <p className="text-xs text-slate-400 mt-3">
              Detection is content-hash based (SHA-256 of normalized extracted text) — a page
              is only re-processed when its hash actually changes, not on a fixed schedule.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
