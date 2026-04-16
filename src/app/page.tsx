"use client";

import { useState, useRef } from "react";

interface PageResult {
  page: string;
  canonical: string;
  canonicalStatus: "Correct" | "Wrong" | "Missing";
  httpStatus: number;
  metaTitle: string;
  metaDescription: string;
}

interface WwwStatus {
  siteVersion: "www" | "non-www" | "both" | "unknown";
  wwwReachable: boolean;
  nonWwwReachable: boolean;
  wwwRedirectsTo: string;
  nonWwwRedirectsTo: string;
  wwwUrl: string;
  nonWwwUrl: string;
}

interface SitemapInfo {
  found: boolean;
  totalUrls: number;
  urlsWithWww: number;
  urlsWithoutWww: number;
  sampleUrls: string[];
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [results, setResults] = useState<PageResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [filter, setFilter] = useState<
    "all" | "Correct" | "Wrong" | "Missing"
  >("all");
  const [wwwStatus, setWwwStatus] = useState<WwwStatus | null>(null);
  const [sitemapInfo, setSitemapInfo] = useState<SitemapInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;

    setResults([]);
    setIsLoading(true);
    setTotal(0);
    setProgress(0);
    setStatusMessage("Connecting...");
    setFilter("all");
    setWwwStatus(null);
    setSitemapInfo(null);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
        signal: abortRef.current.signal,
      });

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataMatch = line.match(/^data: (.+)$/m);
          if (!dataMatch) continue;

          const data = JSON.parse(dataMatch[1]);

          if (data.type === "status") {
            setStatusMessage(data.message);
          } else if (data.type === "wwwStatus") {
            setWwwStatus(data);
          } else if (data.type === "sitemapInfo") {
            setSitemapInfo(data.sitemapInfo);
          } else if (data.type === "total") {
            setTotal(data.total);
            setStatusMessage(`Checking ${data.total} pages...`);
          } else if (data.type === "result") {
            setResults((prev) => [...prev, data.result]);
            setProgress(data.progress);
          } else if (data.type === "done") {
            setStatusMessage("Done!");
          } else if (data.type === "error") {
            setStatusMessage(`Error: ${data.message}`);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setStatusMessage(`Error: ${err.message}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setIsLoading(false);
    setStatusMessage("Stopped.");
  };

  // Compute canonical www stats
  const canonicalsWithWww = results.filter(
    (r) => r.canonical !== "NONE" && r.canonical !== "ERROR" && r.canonical.includes("://www.")
  ).length;
  const canonicalsWithoutWww = results.filter(
    (r) =>
      r.canonical !== "NONE" &&
      r.canonical !== "ERROR" &&
      !r.canonical.includes("://www.")
  ).length;

  const exportCSV = () => {
    const headers = [
      "Page URL",
      "Canonical URL",
      "Canonical Status",
      "Canonical Uses WWW",
      "HTTP Status",
      "Meta Title",
      "Meta Description",
    ];
    const rows = filteredResults.map((r) => [
      r.page,
      r.canonical,
      r.canonicalStatus,
      r.canonical.includes("://www.") ? "Yes" : "No",
      r.httpStatus,
      `"${r.metaTitle.replace(/"/g, '""')}"`,
      `"${r.metaDescription.replace(/"/g, '""')}"`,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    const domain = new URL(
      url.startsWith("http") ? url : `https://${url}`
    ).hostname.replace("www.", "");
    link.href = URL.createObjectURL(blob);
    link.download = `canonical-audit-${domain}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
  };

  const filteredResults =
    filter === "all"
      ? results
      : results.filter((r) => r.canonicalStatus === filter);

  const correctCount = results.filter(
    (r) => r.canonicalStatus === "Correct"
  ).length;
  const wrongCount = results.filter(
    (r) => r.canonicalStatus === "Wrong"
  ).length;
  const missingCount = results.filter(
    (r) => r.canonicalStatus === "Missing"
  ).length;

  // Find duplicate meta titles (dedupe by pathname to avoid www/non-www false positives)
  const titleMap = new Map<string, string[]>();
  results.forEach((r) => {
    if (r.metaTitle) {
      const path = new URL(r.page).pathname || "/";
      const existing = titleMap.get(r.metaTitle) || [];
      // Only add if this pathname isn't already tracked for this title
      if (!existing.some((p) => new URL(p).pathname === path)) {
        existing.push(r.page);
      }
      titleMap.set(r.metaTitle, existing);
    }
  });
  const duplicateTitles = [...titleMap.entries()].filter(
    ([, pages]) => pages.length > 1
  );

  // Find duplicate meta descriptions (dedupe by pathname)
  const descMap = new Map<string, string[]>();
  results.forEach((r) => {
    if (r.metaDescription) {
      const path = new URL(r.page).pathname || "/";
      const existing = descMap.get(r.metaDescription) || [];
      if (!existing.some((p) => new URL(p).pathname === path)) {
        existing.push(r.page);
      }
      descMap.set(r.metaDescription, existing);
    }
  });
  const duplicateDescs = [...descMap.entries()].filter(
    ([, pages]) => pages.length > 1
  );

  return (
    <main className="max-w-[1400px] mx-auto px-4 py-8">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">
          Canonical & Meta Tag Checker
        </h1>
        <p className="text-slate-400">
          Enter a website URL to crawl and check canonical tags, meta titles,
          and meta descriptions.
        </p>
      </div>

      {/* URL Input */}
      <form
        onSubmit={handleSubmit}
        className="flex gap-3 mb-8 max-w-2xl mx-auto"
      >
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          className="flex-1 px-4 py-3 rounded-lg bg-slate-800 border border-slate-600 text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
          disabled={isLoading}
        />
        {isLoading ? (
          <button
            type="button"
            onClick={handleStop}
            className="px-6 py-3 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium transition-colors"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
          >
            Check Site
          </button>
        )}
      </form>

      {/* Progress Bar */}
      {isLoading && total > 0 && (
        <div className="max-w-2xl mx-auto mb-6">
          <div className="flex justify-between text-sm text-slate-400 mb-1">
            <span>{statusMessage}</span>
            <span>
              {progress} / {total}
            </span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${(progress / total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* WWW Status Panel */}
      {wwwStatus && (
        <div className="bg-slate-800 rounded-lg p-5 mb-6 border border-slate-700">
          <h2 className="text-lg font-semibold text-white mb-3">
            WWW vs Non-WWW Analysis
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Site serves on */}
            <div className="bg-slate-900/50 rounded-lg p-4">
              <div className="text-sm text-slate-400 mb-1">Site serves on</div>
              <div className="text-white font-medium">
                {wwwStatus.siteVersion === "www" && (
                  <span className="text-blue-400">www (preferred)</span>
                )}
                {wwwStatus.siteVersion === "non-www" && (
                  <span className="text-blue-400">non-www (preferred)</span>
                )}
                {wwwStatus.siteVersion === "both" && (
                  <span className="text-yellow-400">
                    Both accessible (no redirect)
                  </span>
                )}
                {wwwStatus.siteVersion === "unknown" && (
                  <span className="text-red-400">Could not determine</span>
                )}
              </div>
            </div>

            {/* Redirect behavior */}
            <div className="bg-slate-900/50 rounded-lg p-4">
              <div className="text-sm text-slate-400 mb-1">
                Redirect behavior
              </div>
              <div className="text-white text-sm space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${wwwStatus.wwwReachable ? "bg-green-400" : "bg-red-400"}`}
                  />
                  <span>
                    www{" "}
                    {wwwStatus.wwwRedirectsTo
                      ? `redirects to non-www`
                      : wwwStatus.wwwReachable
                        ? "accessible"
                        : "not reachable"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${wwwStatus.nonWwwReachable ? "bg-green-400" : "bg-red-400"}`}
                  />
                  <span>
                    non-www{" "}
                    {wwwStatus.nonWwwRedirectsTo
                      ? `redirects to www`
                      : wwwStatus.nonWwwReachable
                        ? "accessible"
                        : "not reachable"}
                  </span>
                </div>
              </div>
            </div>

            {/* Canonical version usage */}
            {results.length > 0 && (
              <div className="bg-slate-900/50 rounded-lg p-4">
                <div className="text-sm text-slate-400 mb-1">
                  Canonicals point to
                </div>
                <div className="text-white text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-blue-400 font-medium">
                      {canonicalsWithWww}
                    </span>
                    <span>use www</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-blue-400 font-medium">
                      {canonicalsWithoutWww}
                    </span>
                    <span>use non-www</span>
                  </div>
                  {canonicalsWithWww > 0 && canonicalsWithoutWww > 0 && (
                    <div className="text-yellow-400 text-xs mt-1">
                      Mixed www/non-www in canonicals — should be consistent
                    </div>
                  )}
                  {wwwStatus.siteVersion === "www" &&
                    canonicalsWithoutWww > 0 && (
                      <div className="text-yellow-400 text-xs mt-1">
                        Site prefers www but some canonicals use non-www
                      </div>
                    )}
                  {wwwStatus.siteVersion === "non-www" &&
                    canonicalsWithWww > 0 && (
                      <div className="text-yellow-400 text-xs mt-1">
                        Site prefers non-www but some canonicals use www
                      </div>
                    )}
                </div>
              </div>
            )}

            {/* Sitemap URL format */}
            {sitemapInfo && (
              <div className="bg-slate-900/50 rounded-lg p-4">
                <div className="text-sm text-slate-400 mb-1">
                  Sitemap URLs
                </div>
                {!sitemapInfo.found ? (
                  <div className="text-yellow-400 text-sm">
                    No sitemap.xml found
                  </div>
                ) : (
                  <div className="text-white text-sm space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-blue-400 font-medium">
                        {sitemapInfo.urlsWithWww}
                      </span>
                      <span>use www</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-blue-400 font-medium">
                        {sitemapInfo.urlsWithoutWww}
                      </span>
                      <span>use non-www</span>
                    </div>
                    {wwwStatus.siteVersion === "www" &&
                      sitemapInfo.urlsWithoutWww > 0 && (
                        <div className="text-red-400 text-xs mt-1 font-medium">
                          Site uses www but sitemap has non-www URLs
                        </div>
                      )}
                    {wwwStatus.siteVersion === "non-www" &&
                      sitemapInfo.urlsWithWww > 0 && (
                        <div className="text-red-400 text-xs mt-1 font-medium">
                          Site uses non-www but sitemap has www URLs
                        </div>
                      )}
                    {sitemapInfo.urlsWithWww > 0 &&
                      sitemapInfo.urlsWithoutWww > 0 && (
                        <div className="text-yellow-400 text-xs mt-1">
                          Mixed www/non-www in sitemap
                        </div>
                      )}
                    {wwwStatus.siteVersion !== "unknown" &&
                      ((wwwStatus.siteVersion === "www" &&
                        sitemapInfo.urlsWithoutWww === 0) ||
                        (wwwStatus.siteVersion === "non-www" &&
                          sitemapInfo.urlsWithWww === 0)) && (
                        <div className="text-green-400 text-xs mt-1">
                          Sitemap matches site preference
                        </div>
                      )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Summary Stats */}
      {results.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <button
              className={`bg-slate-800 rounded-lg p-4 text-center border-2 transition-colors ${
                filter === "all"
                  ? "border-blue-500"
                  : "border-transparent hover:border-slate-600"
              }`}
              onClick={() => setFilter("all")}
            >
              <div className="text-2xl font-bold text-white">
                {results.length}
              </div>
              <div className="text-slate-400 text-sm">Total Pages</div>
            </button>
            <button
              className={`bg-slate-800 rounded-lg p-4 text-center border-2 transition-colors ${
                filter === "Correct"
                  ? "border-green-500"
                  : "border-transparent hover:border-slate-600"
              }`}
              onClick={() => setFilter("Correct")}
            >
              <div className="text-2xl font-bold text-green-400">
                {correctCount}
              </div>
              <div className="text-slate-400 text-sm">Correct</div>
            </button>
            <button
              className={`bg-slate-800 rounded-lg p-4 text-center border-2 transition-colors ${
                filter === "Wrong"
                  ? "border-red-500"
                  : "border-transparent hover:border-slate-600"
              }`}
              onClick={() => setFilter("Wrong")}
            >
              <div className="text-2xl font-bold text-red-400">
                {wrongCount}
              </div>
              <div className="text-slate-400 text-sm">Wrong</div>
            </button>
            <button
              className={`bg-slate-800 rounded-lg p-4 text-center border-2 transition-colors ${
                filter === "Missing"
                  ? "border-yellow-500"
                  : "border-transparent hover:border-slate-600"
              }`}
              onClick={() => setFilter("Missing")}
            >
              <div className="text-2xl font-bold text-yellow-400">
                {missingCount}
              </div>
              <div className="text-slate-400 text-sm">Missing</div>
            </button>
          </div>

          {/* Duplicate Meta Tags Panel */}
          {(duplicateTitles.length > 0 || duplicateDescs.length > 0) && (
            <div className="bg-slate-800 rounded-lg p-5 mb-6 border border-slate-700">
              <h2 className="text-lg font-semibold text-white mb-3">
                Duplicate Meta Tags
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Duplicate Titles */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        duplicateTitles.length > 0
                          ? "bg-red-900/50 text-red-400"
                          : "bg-green-900/50 text-green-400"
                      }`}
                    >
                      {duplicateTitles.length > 0
                        ? `${duplicateTitles.length} duplicate title${duplicateTitles.length > 1 ? "s" : ""}`
                        : "No duplicates"}
                    </span>
                    <span className="text-sm text-slate-400">Meta Titles</span>
                  </div>
                  {duplicateTitles.length > 0 && (
                    <div className="space-y-3 max-h-[300px] overflow-y-auto">
                      {duplicateTitles.map(([title, pages]) => (
                        <div
                          key={title}
                          className="bg-slate-900/50 rounded p-3"
                        >
                          <div className="text-sm text-red-400 font-medium mb-1 truncate" title={title}>
                            &quot;{title}&quot;
                          </div>
                          <div className="text-xs text-slate-400">
                            Used on {pages.length} pages:
                          </div>
                          <ul className="text-xs text-slate-500 mt-1 space-y-0.5">
                            {pages.map((p) => (
                              <li key={p} className="truncate">
                                {new URL(p).pathname || "/"}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Duplicate Descriptions */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                        duplicateDescs.length > 0
                          ? "bg-red-900/50 text-red-400"
                          : "bg-green-900/50 text-green-400"
                      }`}
                    >
                      {duplicateDescs.length > 0
                        ? `${duplicateDescs.length} duplicate description${duplicateDescs.length > 1 ? "s" : ""}`
                        : "No duplicates"}
                    </span>
                    <span className="text-sm text-slate-400">
                      Meta Descriptions
                    </span>
                  </div>
                  {duplicateDescs.length > 0 && (
                    <div className="space-y-3 max-h-[300px] overflow-y-auto">
                      {duplicateDescs.map(([desc, pages]) => (
                        <div
                          key={desc}
                          className="bg-slate-900/50 rounded p-3"
                        >
                          <div className="text-sm text-red-400 font-medium mb-1 truncate" title={desc}>
                            &quot;{desc.slice(0, 80)}
                            {desc.length > 80 ? "..." : ""}&quot;
                          </div>
                          <div className="text-xs text-slate-400">
                            Used on {pages.length} pages:
                          </div>
                          <ul className="text-xs text-slate-500 mt-1 space-y-0.5">
                            {pages.map((p) => (
                              <li key={p} className="truncate">
                                {new URL(p).pathname || "/"}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Export Button */}
          <div className="flex justify-end mb-4">
            <button
              onClick={exportCSV}
              className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium transition-colors flex items-center gap-2"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              Export CSV ({filteredResults.length} rows)
            </button>
          </div>

          {/* Results Table */}
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-slate-300">
                  <th className="text-left px-4 py-3 font-medium">#</th>
                  <th className="text-left px-4 py-3 font-medium">Page URL</th>
                  <th className="text-left px-4 py-3 font-medium">
                    Canonical URL
                  </th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">HTTP</th>
                  <th className="text-left px-4 py-3 font-medium">
                    Meta Title
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    Meta Description
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((r, i) => (
                  <tr
                    key={r.page}
                    className="border-t border-slate-700 hover:bg-slate-800/50"
                  >
                    <td className="px-4 py-3 text-slate-400">{i + 1}</td>
                    <td className="px-4 py-3">
                      <a
                        href={r.page}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:underline break-all"
                      >
                        {new URL(r.page).pathname || "/"}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-slate-300 break-all max-w-[250px]">
                      {r.canonical}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                          r.canonicalStatus === "Correct"
                            ? "bg-green-900/50 text-green-400"
                            : r.canonicalStatus === "Wrong"
                              ? "bg-red-900/50 text-red-400"
                              : "bg-yellow-900/50 text-yellow-400"
                        }`}
                      >
                        {r.canonicalStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{r.httpStatus}</td>
                    <td className="px-4 py-3 text-slate-300 max-w-[200px]">
                      <div className="truncate" title={r.metaTitle}>
                        {r.metaTitle || (
                          <span className="text-yellow-400">Missing</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-300 max-w-[250px]">
                      <div className="truncate" title={r.metaDescription}>
                        {r.metaDescription || (
                          <span className="text-yellow-400">Missing</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Empty state */}
      {!isLoading && results.length === 0 && !statusMessage && (
        <div className="text-center text-slate-500 mt-12">
          <p>
            Enter a URL above to start checking canonical tags and meta data.
          </p>
        </div>
      )}

      {/* Loading but no total yet */}
      {isLoading && total === 0 && (
        <div className="text-center text-slate-400 mt-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500 mb-4" />
          <p>{statusMessage}</p>
        </div>
      )}
    </main>
  );
}
