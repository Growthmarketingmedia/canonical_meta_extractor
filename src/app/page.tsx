"use client";

import { useState, useRef, Fragment } from "react";

interface ImageInfo {
  src: string;
  alt: string;
  hasAlt: boolean;
}

interface PageResult {
  page: string;
  canonical: string;
  canonicalStatus: "Correct" | "Wrong" | "Missing" | "Redirect";
  httpStatus: number;
  metaTitle: string;
  metaDescription: string;
  redirectTo?: string;
  robots: string;
  indexable: "Indexable" | "Noindex" | "Unknown";
  crawlable: "Allowed" | "Disallowed";
  blockingRule?: string;
  images: ImageInfo[];
  imagesMissingAlt: number;
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
  source: string;
  sitemapUrl: string;
  totalUrls: number;
  urlsWithWww: number;
  urlsWithoutWww: number;
  sampleUrls: string[];
  robotsTxtExists: boolean;
  robotsDeclaredSitemap: string;
  robotsSitemapBroken: boolean;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [results, setResults] = useState<PageResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [filter, setFilter] = useState<
    "all" | "Correct" | "Wrong" | "Missing" | "Redirect"
  >("all");
  const [wwwStatus, setWwwStatus] = useState<WwwStatus | null>(null);
  const [sitemapInfo, setSitemapInfo] = useState<SitemapInfo | null>(null);
  const [expandedImages, setExpandedImages] = useState<Set<string>>(new Set());

  const toggleImagesRow = (pageUrl: string) => {
    setExpandedImages((prev) => {
      const next = new Set(prev);
      if (next.has(pageUrl)) {
        next.delete(pageUrl);
      } else {
        next.add(pageUrl);
      }
      return next;
    });
  };
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
      "Redirects To",
      "Canonical Uses WWW",
      "HTTP Status",
      "Indexable",
      "Robots Meta",
      "Crawlable",
      "Blocking Rule",
      "Total Images",
      "Images Missing Alt",
      "Meta Title",
      "Meta Description",
    ];
    const rows = filteredResults.map((r) => [
      r.page,
      r.canonical,
      r.canonicalStatus,
      r.redirectTo || "",
      r.canonical.includes("://www.") ? "Yes" : "No",
      r.httpStatus,
      r.indexable,
      `"${(r.robots || "").replace(/"/g, '""')}"`,
      r.crawlable,
      r.blockingRule || "",
      r.images?.length || 0,
      r.imagesMissingAlt || 0,
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

  const [promptCopied, setPromptCopied] = useState(false);

  const generateFixPrompt = () => {
    const domain = new URL(
      url.startsWith("http") ? url : `https://${url}`
    ).hostname;

    const wrongPages = results.filter((r) => r.canonicalStatus === "Wrong");
    const missingPages = results.filter((r) => r.canonicalStatus === "Missing");
    const dupTitles = duplicateTitles;
    const dupDescs = duplicateDescs;

    const sitePreference = wwwStatus?.siteVersion || "unknown";
    const sitemapMismatch =
      sitemapInfo &&
      wwwStatus &&
      ((wwwStatus.siteVersion === "www" && sitemapInfo.urlsWithoutWww > 0) ||
        (wwwStatus.siteVersion === "non-www" && sitemapInfo.urlsWithWww > 0));

    let prompt = `# SEO Fix Instructions for ${domain}\n\n`;
    prompt += `I've attached a CSV audit file (canonical-audit-${domain.replace("www.", "")}-${new Date().toISOString().slice(0, 10)}.csv) with full results. Please fix the following issues:\n\n`;

    // Canonical issues
    if (wrongPages.length > 0) {
      prompt += `## 1. Fix Wrong Canonical Tags (${wrongPages.length} pages)\n\n`;
      prompt += `${wrongPages.length} pages have their canonical tag pointing to the homepage instead of themselves. Each page must have a self-referencing canonical tag.\n\n`;
      prompt += `**How to fix in Next.js:**\n`;
      prompt += `In each page's metadata (or layout), set the canonical URL to match the page's own URL. Example:\n\n`;
      prompt += `\`\`\`typescript\n`;
      prompt += `// In app/[slug]/page.tsx or the relevant page file\n`;
      prompt += `export async function generateMetadata({ params }) {\n`;
      prompt += `  return {\n`;
      prompt += `    alternates: {\n`;
      prompt += `      canonical: \`https://${sitePreference === "www" ? "www." : ""}${domain.replace("www.", "")}/\${params.slug}\`,\n`;
      prompt += `    },\n`;
      prompt += `  };\n`;
      prompt += `}\n`;
      prompt += `\`\`\`\n\n`;
      prompt += `**Pages affected (see CSV for full list):**\n`;
      wrongPages.slice(0, 10).forEach((r) => {
        prompt += `- ${new URL(r.page).pathname} → currently points to: ${r.canonical}\n`;
      });
      if (wrongPages.length > 10) {
        prompt += `- ... and ${wrongPages.length - 10} more (see CSV)\n`;
      }
      prompt += `\n`;
    }

    // Missing canonicals
    if (missingPages.length > 0) {
      prompt += `## 2. Add Missing Canonical Tags (${missingPages.length} pages)\n\n`;
      prompt += `These pages have no canonical tag at all. Add a self-referencing canonical to each:\n`;
      missingPages.forEach((r) => {
        prompt += `- ${new URL(r.page).pathname}\n`;
      });
      prompt += `\n`;
    }

    // WWW consistency
    if (sitemapMismatch) {
      const nextSection = wrongPages.length > 0 && missingPages.length > 0 ? "3" : wrongPages.length > 0 || missingPages.length > 0 ? "2" : "1";
      prompt += `## ${nextSection}. Fix Sitemap URL Format Mismatch\n\n`;
      prompt += `The site serves on **${sitePreference}** but the sitemap.xml contains **${sitePreference === "www" ? "non-www" : "www"}** URLs.\n`;
      prompt += `Update the sitemap generation to use **${sitePreference === "www" ? "https://www." : "https://"}${domain.replace("www.", "")}** for all URLs.\n\n`;
    }

    // Canonical www mismatch
    if (
      wwwStatus &&
      ((sitePreference === "www" && canonicalsWithoutWww > 0) ||
        (sitePreference === "non-www" && canonicalsWithWww > 0))
    ) {
      prompt += `## Fix Canonical URL Format\n\n`;
      prompt += `The site prefers **${sitePreference}** but some canonicals use the opposite format.\n`;
      prompt += `All canonical tags should use: **${sitePreference === "www" ? "https://www." : "https://"}${domain.replace("www.", "")}**\n\n`;
    }

    // Duplicate meta titles
    if (dupTitles.length > 0) {
      prompt += `## Fix Duplicate Meta Titles (${dupTitles.length} duplicates)\n\n`;
      prompt += `Each page should have a unique meta title. These pages share the same title:\n\n`;
      dupTitles.forEach(([title, pages]) => {
        prompt += `**"${title}"** used on:\n`;
        pages.forEach((p) => {
          prompt += `  - ${new URL(p).pathname}\n`;
        });
        prompt += `\n`;
      });
    }

    // Duplicate meta descriptions
    if (dupDescs.length > 0) {
      prompt += `## Fix Duplicate Meta Descriptions (${dupDescs.length} duplicates)\n\n`;
      prompt += `Each page should have a unique meta description. These pages share the same description:\n\n`;
      dupDescs.forEach(([desc, pages]) => {
        prompt += `**"${desc.slice(0, 80)}${desc.length > 80 ? "..." : ""}"** used on:\n`;
        pages.forEach((p) => {
          prompt += `  - ${new URL(p).pathname}\n`;
        });
        prompt += `\n`;
      });
    }

    prompt += `---\n`;
    prompt += `Refer to the attached CSV for the complete page-by-page breakdown.\n`;

    return prompt;
  };

  const copyFixPrompt = () => {
    const prompt = generateFixPrompt();
    navigator.clipboard.writeText(prompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
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
  const redirectCount = results.filter(
    (r) => r.canonicalStatus === "Redirect"
  ).length;
  const noindexCount = results.filter((r) => r.indexable === "Noindex").length;
  const disallowedCount = results.filter(
    (r) => r.crawlable === "Disallowed"
  ).length;
  const totalImages = results.reduce(
    (sum, r) => sum + (r.images?.length || 0),
    0
  );
  const totalImagesMissingAlt = results.reduce(
    (sum, r) => sum + (r.imagesMissingAlt || 0),
    0
  );
  const pagesWithMissingAlt = results.filter(
    (r) => (r.imagesMissingAlt || 0) > 0
  ).length;

  // Exclude from duplicate detection:
  // 1. Redirecting pages — they share meta with their target by design
  // 2. Non-200 pages (404s, errors) — they serve the error template, not real content
  const dedupeResults = results.filter(
    (r) =>
      r.canonicalStatus !== "Redirect" &&
      r.httpStatus >= 200 &&
      r.httpStatus < 300
  );

  // Find duplicate meta titles (dedupe by pathname to avoid www/non-www false positives)
  const titleMap = new Map<string, string[]>();
  dedupeResults.forEach((r) => {
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
  dedupeResults.forEach((r) => {
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
                  Sitemap
                </div>
                {!sitemapInfo.found ? (
                  <div className="text-sm space-y-1">
                    <div className="text-red-400 font-medium">
                      No sitemap found
                    </div>
                    {sitemapInfo.robotsSitemapBroken && (
                      <div className="text-red-400 text-xs">
                        robots.txt declares sitemap at{" "}
                        <span className="text-slate-300">
                          {new URL(sitemapInfo.robotsDeclaredSitemap).pathname}
                        </span>{" "}
                        but it returns 404
                      </div>
                    )}
                    {!sitemapInfo.robotsTxtExists && (
                      <div className="text-yellow-400 text-xs">
                        No robots.txt found either
                      </div>
                    )}
                    {sitemapInfo.robotsTxtExists &&
                      !sitemapInfo.robotsDeclaredSitemap && (
                        <div className="text-yellow-400 text-xs">
                          robots.txt exists but has no Sitemap declaration
                        </div>
                      )}
                    <div className="text-slate-500 text-xs">
                      Pages discovered from homepage links only
                    </div>
                  </div>
                ) : (
                  <div className="text-white text-sm space-y-1">
                    <div className="text-green-400 text-xs font-medium">
                      Found via {sitemapInfo.source}
                    </div>
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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
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
            <button
              className={`bg-slate-800 rounded-lg p-4 text-center border-2 transition-colors ${
                filter === "Redirect"
                  ? "border-purple-500"
                  : "border-transparent hover:border-slate-600"
              }`}
              onClick={() => setFilter("Redirect")}
            >
              <div className="text-2xl font-bold text-purple-400">
                {redirectCount}
              </div>
              <div className="text-slate-400 text-sm">Redirect</div>
            </button>
          </div>

          {/* Image Alt Tag Summary */}
          {totalImagesMissingAlt > 0 && (
            <div className="bg-yellow-950/30 border border-yellow-900/50 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                <div>
                  <div className="text-yellow-400 font-medium mb-1">
                    {totalImagesMissingAlt} image{totalImagesMissingAlt > 1 ? "s" : ""} missing alt text across {pagesWithMissingAlt} page{pagesWithMissingAlt > 1 ? "s" : ""}
                  </div>
                  <div className="text-yellow-300/80 text-sm">
                    Out of {totalImages} total images. Alt text is critical for accessibility (screen readers) and SEO (image search). Click any page&apos;s image count below to see the full list of images and their alt status.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Disallowed (robots.txt) Pages Warning */}
          {disallowedCount > 0 && (
            <div className="bg-orange-950/30 border border-orange-900/50 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                  />
                </svg>
                <div>
                  <div className="text-orange-400 font-medium mb-1">
                    {disallowedCount} page{disallowedCount > 1 ? "s" : ""} blocked by robots.txt
                  </div>
                  <div className="text-orange-300/80 text-sm">
                    These pages are blocked from being crawled by Google via robots.txt Disallow rules. Note: blocked pages can still appear in search results if linked from elsewhere — to fully prevent indexing, use a noindex meta tag (and don&apos;t block via robots.txt).
                  </div>
                  <ul className="text-orange-300/80 text-sm mt-2 space-y-0.5">
                    {results
                      .filter((r) => r.crawlable === "Disallowed")
                      .map((r) => (
                        <li key={r.page}>
                          <a
                            href={r.page}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-orange-300 hover:text-orange-200 hover:underline"
                          >
                            {new URL(r.page).pathname || "/"}
                          </a>
                          <span className="text-orange-400/60 ml-2 text-xs">
                            (rule: Disallow: {r.blockingRule})
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Noindex Pages Warning */}
          {noindexCount > 0 && (
            <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4 mb-6">
              <div className="flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <div>
                  <div className="text-red-400 font-medium mb-1">
                    {noindexCount} page{noindexCount > 1 ? "s" : ""} set to Noindex
                  </div>
                  <div className="text-red-300/80 text-sm">
                    These pages have a robots meta tag telling search engines not to index them. If unintentional, this is a critical SEO issue — the pages won&apos;t appear in Google search results.
                  </div>
                  <ul className="text-red-300/80 text-sm mt-2 space-y-0.5">
                    {results
                      .filter((r) => r.indexable === "Noindex")
                      .map((r) => (
                        <li key={r.page}>
                          <a
                            href={r.page}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-red-300 hover:text-red-200 hover:underline"
                          >
                            {new URL(r.page).pathname || "/"}
                          </a>
                          <span className="text-red-400/60 ml-2 text-xs">
                            ({r.robots})
                          </span>
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            </div>
          )}

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
                          <ul className="text-xs mt-1 space-y-0.5">
                            {pages.map((p) => (
                              <li key={p} className="truncate">
                                <a
                                  href={p}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:text-blue-300 hover:underline"
                                >
                                  {new URL(p).pathname || "/"}
                                </a>
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
                          <ul className="text-xs mt-1 space-y-0.5">
                            {pages.map((p) => (
                              <li key={p} className="truncate">
                                <a
                                  href={p}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-400 hover:text-blue-300 hover:underline"
                                >
                                  {new URL(p).pathname || "/"}
                                </a>
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

          {/* Action Buttons */}
          <div className="flex justify-end gap-3 mb-4">
            <button
              onClick={copyFixPrompt}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                promptCopied
                  ? "bg-green-600 text-white"
                  : "bg-purple-600 hover:bg-purple-700 text-white"
              }`}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {promptCopied ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
                  />
                )}
              </svg>
              {promptCopied ? "Copied!" : "Copy Fix Prompt for Cursor"}
            </button>
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
                  <th className="text-left px-4 py-3 font-medium">Indexable</th>
                  <th className="text-left px-4 py-3 font-medium">Crawlable</th>
                  <th className="text-left px-4 py-3 font-medium">Images</th>
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
                  <Fragment key={r.page}>
                  <tr
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
                      {r.canonicalStatus === "Redirect" && r.redirectTo ? (
                        <div className="text-xs">
                          <div className="text-purple-400 mb-1">
                            → {new URL(r.redirectTo).pathname || "/"}
                          </div>
                          <div className="text-slate-500">
                            Canonical: {r.canonical}
                          </div>
                        </div>
                      ) : (
                        r.canonical
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                          r.canonicalStatus === "Correct"
                            ? "bg-green-900/50 text-green-400"
                            : r.canonicalStatus === "Wrong"
                              ? "bg-red-900/50 text-red-400"
                              : r.canonicalStatus === "Redirect"
                                ? "bg-purple-900/50 text-purple-400"
                                : "bg-yellow-900/50 text-yellow-400"
                        }`}
                      >
                        {r.canonicalStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-400">{r.httpStatus}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                          r.indexable === "Indexable"
                            ? "bg-green-900/50 text-green-400"
                            : r.indexable === "Noindex"
                              ? "bg-red-900/50 text-red-400"
                              : "bg-slate-700/50 text-slate-400"
                        }`}
                        title={r.robots || "No robots meta tag"}
                      >
                        {r.indexable}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-1 rounded text-xs font-medium ${
                          r.crawlable === "Allowed"
                            ? "bg-green-900/50 text-green-400"
                            : "bg-orange-900/50 text-orange-400"
                        }`}
                        title={
                          r.blockingRule
                            ? `Blocked by rule: Disallow: ${r.blockingRule}`
                            : "Allowed by robots.txt"
                        }
                      >
                        {r.crawlable}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {r.images && r.images.length > 0 ? (
                        <button
                          onClick={() => toggleImagesRow(r.page)}
                          className="flex items-center gap-2 text-sm hover:text-blue-300 transition-colors"
                        >
                          <svg
                            className={`w-3 h-3 transition-transform ${
                              expandedImages.has(r.page) ? "rotate-90" : ""
                            }`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 5l7 7-7 7"
                            />
                          </svg>
                          <span className="text-slate-300">{r.images.length}</span>
                          {r.imagesMissingAlt > 0 && (
                            <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-red-900/50 text-red-400">
                              {r.imagesMissingAlt} no alt
                            </span>
                          )}
                          {r.imagesMissingAlt === 0 && r.images.length > 0 && (
                            <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-green-900/50 text-green-400">
                              all alt
                            </span>
                          )}
                        </button>
                      ) : (
                        <span className="text-slate-500 text-xs">0</span>
                      )}
                    </td>
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
                  {expandedImages.has(r.page) && r.images && r.images.length > 0 && (
                    <tr className="bg-slate-900/40">
                      <td colSpan={11} className="px-4 py-3">
                        <div className="text-xs text-slate-400 mb-2">
                          Images on{" "}
                          <span className="text-slate-300">
                            {new URL(r.page).pathname || "/"}
                          </span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-slate-500 border-b border-slate-700">
                                <th className="text-left px-2 py-1 font-medium">#</th>
                                <th className="text-left px-2 py-1 font-medium">Image Source</th>
                                <th className="text-left px-2 py-1 font-medium">Alt Text</th>
                                <th className="text-left px-2 py-1 font-medium">Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {r.images.map((img, imgIdx) => (
                                <tr key={img.src} className="border-t border-slate-800/50">
                                  <td className="px-2 py-1.5 text-slate-500">{imgIdx + 1}</td>
                                  <td className="px-2 py-1.5 max-w-[400px]">
                                    <a
                                      href={img.src}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-blue-400 hover:underline break-all"
                                    >
                                      {img.src.split("/").pop() || img.src}
                                    </a>
                                  </td>
                                  <td className="px-2 py-1.5 text-slate-300 max-w-[300px]">
                                    {img.hasAlt ? (
                                      img.alt ? (
                                        <span className="truncate block" title={img.alt}>
                                          &quot;{img.alt}&quot;
                                        </span>
                                      ) : (
                                        <span className="text-slate-500 italic">
                                          (empty alt - decorative)
                                        </span>
                                      )
                                    ) : (
                                      <span className="text-red-400 italic">No alt attribute</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5">
                                    <span
                                      className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                                        img.hasAlt
                                          ? "bg-green-900/50 text-green-400"
                                          : "bg-red-900/50 text-red-400"
                                      }`}
                                    >
                                      {img.hasAlt ? "OK" : "Missing"}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
