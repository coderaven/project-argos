import { NextRequest, NextResponse } from "next/server";

// Allow up to 300s (Vercel Pro max) for long crawls
export const maxDuration = 300;

const OXYLABS_USER = process.env.OXYLABS_USER!;
const OXYLABS_PASS = process.env.OXYLABS_PASS!;
const OXYLABS_URL = "https://realtime.oxylabs.io/v1/queries";

// ── Filter sets ───────────────────────────────────────────────────────────────

const AMAZON_SELLERS = new Set([
  "amazon.com",
  "amazon export sales llc",
  "amazon digital services llc",
  "amazon media eu s.à r.l.",
  "amazon",
]);

const DIGITAL_SIGNALS = [
  "kindle edition", "kindle", "ebook", "e-book",
  "prime video", "digital", "digital download",
  "digital music", "audible", "streaming",
  "digital edition", "online game code", "game download",
  "software download", "mp3",
];

// Media/entertainment title signals — official releases, not counterfeits
const MEDIA_TITLE_SIGNALS = [
  "blu-ray", "4k ultra hd", "[dvd]", "(dvd)", " dvd", "dvd set",
  "film collection", "movie collection", "complete series",
  "complete seasons", "the complete animated series",
  "season 1", "season 2", "season 3", "criterion collection",
  "(theatrical)", "[blu-ray]", "[4k]", "bonus features",
  "motion picture", "animated series", "anime collection",
];

// Book/coloring book/art book signals — not counterfeit goods
const BOOK_TITLE_SIGNALS = [
  "coloring book", "art book", "illustrated history", "official history",
  "encyclopedia", "the art of", "making of", "biography", "history of",
  "pinball machine", "puzzle", "jigsaw",
];

// Amazon categories that indicate official licensed entertainment media
const MEDIA_CATEGORIES = [
  "movies & tv",
  "blu-ray",
  "dvd",
  "amazon video",
  "prime video",
];

// ── Oxylabs helpers ───────────────────────────────────────────────────────────

async function oxylabsSearch(keyword: string, page: number) {
  try {
    const resp = await fetch(OXYLABS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString("base64"),
      },
      body: JSON.stringify({
        source: "amazon_search",
        domain: "com",
        query: keyword,
        start_page: page,
        pages: 1,
        parse: true,
      }),
    });
    if (!resp.ok) {
      console.error(`Oxylabs search failed: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return data?.results?.[0]?.content ?? null;
  } catch (e) {
    console.error("Oxylabs search error:", e);
    return null;
  }
}

async function oxylabsProduct(asin: string) {
  try {
    const resp = await fetch(OXYLABS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString("base64"),
      },
      body: JSON.stringify({
        source: "amazon_product",
        domain: "com",
        query: asin,
        parse: true,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.results?.[0]?.content ?? null;
  } catch (e) {
    console.error("Oxylabs product error:", e);
    return null;
  }
}

// ── Filter helpers ────────────────────────────────────────────────────────────

function isAmazonSeller(seller: string): boolean {
  return AMAZON_SELLERS.has(seller.trim().toLowerCase());
}

function isDigital(title: string, variations: { title?: string }[] = []): boolean {
  const t = title.toLowerCase();
  if (DIGITAL_SIGNALS.some((s) => t.includes(s))) return true;
  const digitalVarTypes = new Set(["kindle edition", "prime video", "digital", "mp3", "audible"]);
  if (variations.length > 0) {
    const allDigital = variations.every((v) => {
      const vt = (v.title ?? "").toLowerCase();
      return DIGITAL_SIGNALS.some((s) => vt.includes(s)) || digitalVarTypes.has(vt);
    });
    if (allDigital) return true;
  }
  return false;
}

function isMediaProduct(title: string, category: string): boolean {
  const t = title.toLowerCase();
  const c = category.toLowerCase();
  if (MEDIA_TITLE_SIGNALS.some((s) => t.includes(s))) return true;
  if (BOOK_TITLE_SIGNALS.some((s) => t.includes(s))) return true;
  if (MEDIA_CATEGORIES.some((s) => c.includes(s))) return true;
  return false;
}

function keywordInTitle(title: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return pattern.test(title);
}

function extractSeller(content: Record<string, unknown>): string {
  const merchant = content.featured_merchant as Record<string, string> | null;
  if (merchant?.name) return merchant.name;
  const buybox = content.buybox as Record<string, string>[] | null;
  if (Array.isArray(buybox) && buybox.length > 0) return buybox[0].seller_name ?? "";
  return "";
}

function extractCategory(content: Record<string, unknown>): string {
  const catList = content.category as { ladder?: { name: string }[] }[] | null;
  if (!Array.isArray(catList) || catList.length === 0) return "";
  const ladder = catList[0].ladder ?? [];
  return ladder.map((c) => c.name).join(" > ");
}

// ── Streaming SSE handler ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();
  const keyword: string = (body.keyword ?? "").trim();
  const maxPages: number = Math.min(Math.max(parseInt(body.pages ?? "20"), 1), 20);

  if (!keyword) {
    return NextResponse.json({ error: "keyword is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`)
        );
      };

      const hits: object[] = [];
      let totalChecked = 0;
      let pagesCrawled = 0;

      try {
        send("status", { message: `Starting scan for "${keyword}" (up to ${maxPages} pages)...` });

        for (let page = 1; page <= maxPages; page++) {
          send("progress", { message: `Searching page ${page} of ${maxPages}...` });

          const content = await oxylabsSearch(keyword, page);

          if (!content) {
            send("progress", { message: `Page ${page}: no data returned, stopping early.` });
            break;
          }

          pagesCrawled = page;

          const resultsBlock = (content.results ?? {}) as Record<string, unknown[]>;
          const items = [
            ...((resultsBlock.organic as Record<string, unknown>[]) ?? []),
            ...((resultsBlock.amazons_choices as Record<string, unknown>[]) ?? []),
          ];

          send("progress", { message: `Page ${page}: ${items.length} products found. Filtering...` });

          // Pre-filter on search page (no API call)
          const candidates = items.filter((item) => {
            const title = (item.title as string) ?? "";
            const variations = (item.variations as { title?: string }[]) ?? [];
            if (!keywordInTitle(title, keyword)) return false;
            if (isDigital(title, variations)) return false;
            if (isMediaProduct(title, "")) return false;
            return true;
          });

          send("progress", { message: `Page ${page}: ${candidates.length} candidates after pre-filter. Checking details in parallel...` });
          totalChecked += candidates.length;

          // Fetch all product details in parallel
          const detailResults = await Promise.all(
            candidates.map(async (item) => {
              const title = (item.title as string) ?? "";
              const asin = (item.asin as string) ?? "";
              const price = item.price ?? "";
              let url = (item.url as string) ?? "";
              if (url && !url.startsWith("http")) url = "https://www.amazon.com" + url;

              send("progress", { message: `Checking ASIN ${asin}: ${title.slice(0, 60)}...` });

              const detail = await oxylabsProduct(asin);
              if (!detail) return null;

              const detailContent = detail as Record<string, unknown>;
              const seller = extractSeller(detailContent);
              const category = extractCategory(detailContent);
              const detailTitle = (detailContent.title as string) ?? title;
              const detailVariations = (detailContent.variation as { title?: string }[]) ?? [];

              if (!seller) return null;
              if (isAmazonSeller(seller)) return null;
              if (isDigital(detailTitle, Array.isArray(detailVariations) ? detailVariations : [])) return null;
              if (isMediaProduct(detailTitle, category)) return null;

              return {
                title: detailTitle || title,
                asin,
                seller,
                price: typeof price === "number" ? `$${price}` : String(price),
                url,
                category,
                reason: `Third-party seller "${seller}" — not Amazon, not digital/media`,
              };
            })
          );

          for (const hit of detailResults) {
            if (!hit) continue;
            hits.push(hit);
            send("candidate", { message: `Hit: ${hit.title} (sold by ${hit.seller})` });
          }

          // Stop early if we've hit the last available page
          const lastVisiblePage = (content.last_visible_page as number) ?? page;
          if (lastVisiblePage <= page) {
            send("progress", { message: `Reached last available page (${page}). Done.` });
            break;
          }
        }

        send("done", {
          report: {
            keyword,
            pages_crawled: pagesCrawled,
            total_products_checked: totalChecked,
            hits,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("Scan error:", err);
        send("error", { message: msg });
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
