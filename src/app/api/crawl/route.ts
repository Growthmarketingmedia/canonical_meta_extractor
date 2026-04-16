import { NextRequest } from "next/server";
import * as cheerio from "cheerio";

interface PageResult {
  page: string;
  canonical: string;
  canonicalStatus: "Correct" | "Wrong" | "Missing";
  httpStatus: number;
  metaTitle: string;
  metaDescription: string;
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

async function discoverPages(baseUrl: string): Promise<string[]> {
  const pages = new Set<string>();
  const origin = new URL(baseUrl).origin;

  // Try sitemap.xml first
  try {
    const sitemapRes = await fetch(`${origin}/sitemap.xml`, {
      signal: AbortSignal.timeout(10000),
    });
    if (sitemapRes.ok) {
      const xml = await sitemapRes.text();
      const $ = cheerio.load(xml, { xmlMode: true });
      $("loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) pages.add(loc);
      });
    }
  } catch {
    // Sitemap not available
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

  // Filter out non-page URLs (sitemaps, XML files, feeds)
  const filtered = [...pages].filter((url) => {
    const path = new URL(url).pathname.toLowerCase();
    return (
      !path.endsWith(".xml") &&
      !path.endsWith("/sitemap.xml") &&
      !path.includes("sitemap") &&
      !path.endsWith("/feed") &&
      !path.endsWith("/rss")
    );
  });

  return filtered.sort();
}

async function checkPage(url: string): Promise<PageResult> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });

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

    // Determine canonical status
    let canonicalStatus: PageResult["canonicalStatus"];
    if (!canonicalHref) {
      canonicalStatus = "Missing";
    } else if (normalizeUrl(canonicalHref) === normalizeUrl(url)) {
      canonicalStatus = "Correct";
    } else {
      canonicalStatus = "Wrong";
    }

    return {
      page: url,
      canonical: canonicalHref || "NONE",
      canonicalStatus,
      httpStatus: res.status,
      metaTitle,
      metaDescription,
    };
  } catch {
    return {
      page: url,
      canonical: "ERROR",
      canonicalStatus: "Missing",
      httpStatus: 0,
      metaTitle: "",
      metaDescription: "",
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
    baseUrl = parsed.origin + parsed.pathname;
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

        const pages = await discoverPages(baseUrl);

        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "total", total: pages.length })}\n\n`
          )
        );

        // Check each page with a small delay
        for (let i = 0; i < pages.length; i++) {
          const result = await checkPage(pages[i]);

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
