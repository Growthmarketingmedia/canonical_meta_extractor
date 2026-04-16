import { NextRequest } from "next/server";
import * as cheerio from "cheerio";

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
}

// Parse robots.txt and return Disallow rules that apply to the universal user-agent (*)
function parseRobotsDisallowRules(robotsTxt: string): string[] {
  const lines = robotsTxt.split(/\r?\n/);
  const rules: string[] = [];
  let inUniversalGroup = false;

  for (const rawLine of lines) {
    // Strip comments
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      // Blank line ends a user-agent group
      inUniversalGroup = false;
      continue;
    }

    const userAgentMatch = line.match(/^User-agent:\s*(.+)$/i);
    if (userAgentMatch) {
      const ua = userAgentMatch[1].trim();
      inUniversalGroup = ua === "*";
      continue;
    }

    if (inUniversalGroup) {
      const disallowMatch = line.match(/^Disallow:\s*(.*)$/i);
      if (disallowMatch) {
        const path = disallowMatch[1].trim();
        // Empty Disallow means "allow all" — skip
        if (path) rules.push(path);
      }
    }
  }

  return rules;
}

// Check if a URL path matches any Disallow rule (basic glob: * wildcard, $ end anchor)
function isDisallowed(
  pathname: string,
  rules: string[]
): { blocked: boolean; rule?: string } {
  for (const rule of rules) {
    // Convert robots.txt pattern to regex
    // * = match anything, $ = end of string, everything else literal
    const escaped = rule
      .replace(/[.+?^{}()|[\]\\]/g, "\\$&") // escape regex special chars
      .replace(/\*/g, ".*"); // * wildcard
    const pattern = escaped.endsWith("$")
      ? `^${escaped.slice(0, -2)}\\$`.replace(/\\\$$/, "$")
      : `^${escaped}`;

    try {
      const re = new RegExp(pattern);
      if (re.test(pathname)) {
        return { blocked: true, rule };
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return { blocked: false };
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove trailing slash, lowercase host
    let normalized = u.origin.toLowerCase() + u.pathname.replace(/\/+$/, "");
    // Remove www prefix for comparison
    normalized = normalized.replace("://www.", "://");
    return normalized || u.origin.toLowerCase();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
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

interface DiscoverResult {
  pages: string[];
  sitemapInfo: SitemapInfo;
  robotsDisallowRules: string[];
}

async function fetchSitemapUrls(
  sitemapUrl: string,
  pages: Set<string>,
  sitemapInfo: SitemapInfo
): Promise<boolean> {
  try {
    const res = await fetch(sitemapUrl, {
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    if (!res.ok) return false;

    const xml = await res.text();
    const $ = cheerio.load(xml, { xmlMode: true });

    // Check if this is a sitemap index (contains <sitemap> tags)
    const subSitemaps = $("sitemap loc");
    if (subSitemaps.length > 0) {
      // It's a sitemap index — fetch each sub-sitemap
      const subUrls: string[] = [];
      subSitemaps.each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) subUrls.push(loc);
      });

      for (const subUrl of subUrls) {
        try {
          const subRes = await fetch(subUrl, {
            signal: AbortSignal.timeout(10000),
          });
          if (subRes.ok) {
            const subXml = await subRes.text();
            const $sub = cheerio.load(subXml, { xmlMode: true });
            $sub("url loc").each((_, el) => {
              const loc = $sub(el).text().trim();
              if (loc) {
                pages.add(loc);
                sitemapInfo.totalUrls++;
                if (loc.includes("://www.")) {
                  sitemapInfo.urlsWithWww++;
                } else {
                  sitemapInfo.urlsWithoutWww++;
                }
                if (sitemapInfo.sampleUrls.length < 3) {
                  sitemapInfo.sampleUrls.push(loc);
                }
              }
            });
          }
        } catch {
          // Sub-sitemap failed
        }
      }
      return sitemapInfo.totalUrls > 0;
    }

    // Regular sitemap — extract <url><loc> tags
    $("url loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) {
        pages.add(loc);
        sitemapInfo.totalUrls++;
        if (loc.includes("://www.")) {
          sitemapInfo.urlsWithWww++;
        } else {
          sitemapInfo.urlsWithoutWww++;
        }
        if (sitemapInfo.sampleUrls.length < 3) {
          sitemapInfo.sampleUrls.push(loc);
        }
      }
    });

    // Fallback: try bare <loc> tags (some sitemaps skip <url> wrapper)
    if (sitemapInfo.totalUrls === 0) {
      $("loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc && loc.startsWith("http")) {
          pages.add(loc);
          sitemapInfo.totalUrls++;
          if (loc.includes("://www.")) {
            sitemapInfo.urlsWithWww++;
          } else {
            sitemapInfo.urlsWithoutWww++;
          }
          if (sitemapInfo.sampleUrls.length < 3) {
            sitemapInfo.sampleUrls.push(loc);
          }
        }
      });
    }

    return sitemapInfo.totalUrls > 0;
  } catch {
    return false;
  }
}

async function discoverPages(baseUrl: string): Promise<DiscoverResult> {
  const pages = new Set<string>();
  const origin = new URL(baseUrl).origin;
  const sitemapInfo: SitemapInfo = {
    found: false,
    source: "",
    sitemapUrl: "",
    totalUrls: 0,
    urlsWithWww: 0,
    urlsWithoutWww: 0,
    sampleUrls: [],
    robotsTxtExists: false,
    robotsDeclaredSitemap: "",
    robotsSitemapBroken: false,
  };

  // Step 1: Check robots.txt for sitemap declaration AND Disallow rules
  let robotsSitemapUrl = "";
  let robotsDisallowRules: string[] = [];
  try {
    const robotsRes = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(10000),
    });
    if (robotsRes.ok) {
      sitemapInfo.robotsTxtExists = true;
      const robotsTxt = await robotsRes.text();
      const sitemapMatch = robotsTxt.match(
        /^Sitemap:\s*(.+)$/im
      );
      if (sitemapMatch) {
        robotsSitemapUrl = sitemapMatch[1].trim();
        sitemapInfo.robotsDeclaredSitemap = robotsSitemapUrl;
      }
      robotsDisallowRules = parseRobotsDisallowRules(robotsTxt);
    }
  } catch {
    // robots.txt not available
  }

  // Step 2: Try sitemap URLs in priority order
  const sitemapCandidates: { url: string; source: string }[] = [];

  // Priority 1: URL declared in robots.txt
  if (robotsSitemapUrl) {
    sitemapCandidates.push({
      url: robotsSitemapUrl,
      source: "robots.txt",
    });
  }

  // Priority 2: Common sitemap paths
  sitemapCandidates.push(
    { url: `${origin}/sitemap.xml`, source: "/sitemap.xml" },
    { url: `${origin}/sitemap_index.xml`, source: "/sitemap_index.xml" },
    { url: `${origin}/wp-sitemap.xml`, source: "/wp-sitemap.xml" }
  );

  // Deduplicate candidates
  const triedUrls = new Set<string>();
  for (const candidate of sitemapCandidates) {
    if (triedUrls.has(candidate.url)) continue;
    triedUrls.add(candidate.url);

    const found = await fetchSitemapUrls(candidate.url, pages, sitemapInfo);
    if (found) {
      sitemapInfo.found = true;
      sitemapInfo.source = candidate.source;
      sitemapInfo.sitemapUrl = candidate.url;
      break;
    }
  }

  // Check if robots.txt declared a sitemap that doesn't work
  if (robotsSitemapUrl && !sitemapInfo.found) {
    sitemapInfo.robotsSitemapBroken = true;
  }

  // Also crawl homepage for links not in sitemap
  try {
    const homeRes = await fetch(baseUrl, {
      signal: AbortSignal.timeout(10000),
    });
    if (homeRes.ok) {
      const html = await homeRes.text();
      const $ = cheerio.load(html);
      $("a[href]").each((_, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        try {
          const resolved = new URL(href, baseUrl);
          if (
            resolved.origin === new URL(baseUrl).origin &&
            !resolved.hash &&
            !resolved.href.includes("tel:") &&
            !resolved.href.includes("mailto:") &&
            !resolved.href.includes("javascript:")
          ) {
            pages.add(
              resolved.origin + resolved.pathname.replace(/\/+$/, "") ||
                resolved.origin
            );
          }
        } catch {
          // Invalid URL
        }
      });
    }
  } catch {
    // Homepage not reachable
  }

  // Ensure base URL is included
  pages.add(origin);

  // Deduplicate by pathname (handles www vs non-www, trailing slashes)
  const seenPaths = new Map<string, string>();
  for (const url of pages) {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/+$/, "") || "/";
      // Keep the first URL we see for each path
      if (!seenPaths.has(path)) {
        seenPaths.set(path, url);
      }
    } catch {
      // skip invalid
    }
  }

  // Filter out non-page URLs (sitemaps, XML files, feeds)
  const filtered = [...seenPaths.values()].filter((url) => {
    const path = new URL(url).pathname.toLowerCase();
    return (
      !path.endsWith(".xml") &&
      !path.endsWith("/sitemap.xml") &&
      !path.includes("sitemap") &&
      !path.endsWith("/feed") &&
      !path.endsWith("/rss")
    );
  });

  return { pages: filtered.sort(), sitemapInfo, robotsDisallowRules };
}

async function checkPage(
  url: string,
  disallowRules: string[] = []
): Promise<PageResult> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });

    // Check if the page redirected to a different URL
    // res.url is the final URL after following redirects
    const finalUrl = res.url;
    const wasRedirected =
      normalizeUrl(finalUrl) !== normalizeUrl(url);

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract canonical
    const canonicalTag = $('link[rel="canonical"]');
    const canonicalHref = canonicalTag.attr("href") || "";

    // Extract meta title
    const metaTitle = $("title").first().text().trim();

    // Extract meta description
    const metaDescription =
      $('meta[name="description"]').attr("content")?.trim() || "";

    // Extract robots meta tag (case-insensitive)
    let robots = "";
    const robotsMeta = $('meta[name="robots"], meta[name="Robots"], meta[name="ROBOTS"]');
    if (robotsMeta.length > 0) {
      robots = (robotsMeta.first().attr("content") || "").trim().toLowerCase();
    }

    // Also check X-Robots-Tag HTTP header
    const xRobotsHeader = res.headers.get("x-robots-tag") || "";
    if (xRobotsHeader && !robots) {
      robots = xRobotsHeader.toLowerCase();
    } else if (xRobotsHeader) {
      robots = `${robots} | X-Robots-Tag: ${xRobotsHeader.toLowerCase()}`;
    }

    // Determine indexability
    let indexable: PageResult["indexable"] = "Indexable";
    if (robots.includes("noindex")) {
      indexable = "Noindex";
    } else if (!robots) {
      // No robots tag = default = indexable
      indexable = "Indexable";
    }

    // Determine canonical status
    let canonicalStatus: PageResult["canonicalStatus"];
    if (wasRedirected) {
      canonicalStatus = "Redirect";
    } else if (!canonicalHref) {
      canonicalStatus = "Missing";
    } else if (normalizeUrl(canonicalHref) === normalizeUrl(url)) {
      canonicalStatus = "Correct";
    } else {
      canonicalStatus = "Wrong";
    }

    // Check if this URL is blocked by robots.txt Disallow rules
    const pathname = new URL(url).pathname;
    const disallowCheck = isDisallowed(pathname, disallowRules);

    return {
      page: url,
      canonical: canonicalHref || "NONE",
      canonicalStatus,
      httpStatus: res.status,
      metaTitle,
      metaDescription,
      redirectTo: wasRedirected ? finalUrl : undefined,
      robots: robots || "(none)",
      indexable,
      crawlable: disallowCheck.blocked ? "Disallowed" : "Allowed",
      blockingRule: disallowCheck.rule,
    };
  } catch {
    // Even on error, check disallow status from URL alone
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      // ignore
    }
    const disallowCheck = pathname
      ? isDisallowed(pathname, disallowRules)
      : { blocked: false, rule: undefined as string | undefined };

    return {
      page: url,
      canonical: "ERROR",
      canonicalStatus: "Missing",
      httpStatus: 0,
      metaTitle: "",
      metaDescription: "",
      robots: "",
      indexable: "Unknown",
      crawlable: disallowCheck.blocked ? "Disallowed" : "Allowed",
      blockingRule: disallowCheck.rule,
    };
  }
}

async function checkWwwStatus(inputUrl: string) {
  const parsed = new URL(inputUrl);
  const host = parsed.hostname;
  const hasWww = host.startsWith("www.");
  const bareHost = hasWww ? host.replace("www.", "") : host;
  const wwwHost = hasWww ? host : `www.${host}`;

  const wwwUrl = `${parsed.protocol}//www.${bareHost}`;
  const nonWwwUrl = `${parsed.protocol}//${bareHost}`;

  let wwwReachable = false;
  let nonWwwReachable = false;
  let wwwRedirectsTo = "";
  let nonWwwRedirectsTo = "";

  // Check non-www version
  try {
    const res = await fetch(nonWwwUrl, {
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    nonWwwReachable = res.ok;
    const finalUrl = res.url;
    if (new URL(finalUrl).hostname !== bareHost) {
      nonWwwRedirectsTo = finalUrl;
    }
  } catch {
    // Not reachable
  }

  // Check www version
  try {
    const res = await fetch(wwwUrl, {
      signal: AbortSignal.timeout(10000),
      redirect: "follow",
    });
    wwwReachable = res.ok;
    const finalUrl = res.url;
    if (new URL(finalUrl).hostname !== wwwHost) {
      wwwRedirectsTo = finalUrl;
    }
  } catch {
    // Not reachable
  }

  // Determine which version the site prefers
  let siteVersion: "www" | "non-www" | "both" | "unknown" = "unknown";
  if (wwwReachable && nonWwwReachable) {
    if (nonWwwRedirectsTo.includes("www.")) {
      siteVersion = "www";
    } else if (wwwRedirectsTo && !wwwRedirectsTo.includes("www.")) {
      siteVersion = "non-www";
    } else {
      siteVersion = "both"; // Both accessible, no redirect — potential issue
    }
  } else if (wwwReachable) {
    siteVersion = "www";
  } else if (nonWwwReachable) {
    siteVersion = "non-www";
  }

  return {
    siteVersion,
    wwwReachable,
    nonWwwReachable,
    wwwRedirectsTo,
    nonWwwRedirectsTo,
    wwwUrl,
    nonWwwUrl,
  };
}

export async function POST(request: NextRequest) {
  const { url } = await request.json();

  if (!url) {
    return new Response(JSON.stringify({ error: "URL is required" }), {
      status: 400,
    });
  }

  // Validate URL
  let baseUrl: string;
  try {
    const parsed = new URL(
      url.startsWith("http") ? url : `https://${url}`
    );
    baseUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch {
    return new Response(JSON.stringify({ error: "Invalid URL" }), {
      status: 400,
    });
  }

  // Stream results using SSE
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Check www vs non-www status first
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "status", message: "Checking www vs non-www..." })}\n\n`
          )
        );

        const wwwStatus = await checkWwwStatus(baseUrl);
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "wwwStatus", ...wwwStatus })}\n\n`
          )
        );

        // Send discovery phase
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "status", message: "Discovering pages..." })}\n\n`
          )
        );

        const { pages, sitemapInfo, robotsDisallowRules } =
          await discoverPages(baseUrl);

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "sitemapInfo", sitemapInfo })}\n\n`
          )
        );

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "total", total: pages.length })}\n\n`
          )
        );

        // Check each page with a small delay
        for (let i = 0; i < pages.length; i++) {
          const result = await checkPage(pages[i], robotsDisallowRules);

          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "result", result, progress: i + 1 })}\n\n`
            )
          );

          // Rate limit: 150ms between requests
          if (i < pages.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        }

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "done" })}\n\n`
          )
        );
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", message: String(error) })}\n\n`
          )
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
