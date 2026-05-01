import { NextRequest, NextResponse } from "next/server";

// Allow up to 300s (Vercel Pro max) for long crawls
export const maxDuration = 300;

const OXYLABS_USER = process.env.OXYLABS_USER!;
const OXYLABS_PASS = process.env.OXYLABS_PASS!;
const OXYLABS_URL = "https://realtime.oxylabs.io/v1/queries";

// ── Seller filter sets ────────────────────────────────────────────────────────

const AMAZON_SELLERS = new Set([
  "amazon.com",
  "amazon export sales llc",
  "amazon digital services llc",
  "amazon media eu s.à r.l.",
  "amazon",
]);

// Asia-based countries we WANT to flag (excl. Japan)
const ASIA_NON_JAPAN_SIGNALS = [
  "china", "chinese", "cn",
  "hong kong", "hk",
  "taiwan", "tw",
  "south korea", "korea", "kr",
  "vietnam", "vn",
  "thailand", "th",
  "philippines", "ph",
  "indonesia", "id",
  "malaysia", "my",
  "singapore", "sg",
  "india", "in",
  "bangladesh", "bd",
  "cambodia", "kh",
  "myanmar", "mm",
  "sri lanka", "lk",
  "pakistan", "pk",
  "shenzhen", "guangzhou", "beijing", "shanghai", "dongguan", "yiwu",
  "guangdong", "zhejiang", "fujian",
];

// Japan — we SKIP these
const JAPAN_SIGNALS = [
  "japan", "japanese", "jp",
  "tokyo", "osaka", "kyoto",
];

// Clearly non-Asian western sellers — skip
const NON_ASIA_SIGNALS = [
  "united states", "usa", "u.s.a",
  "canada", "ca",
  "united kingdom", "uk", "england", "scotland",
  "germany", "de", "deutschland",
  "france", "fr",
  "italy", "it",
  "spain", "es",
  "australia", "au",
  "netherlands", "nl",
  "sweden", "se",
  "norway", "no",
  "denmark", "dk",
  "switzerland", "ch",
  "austria", "at",
  "poland", "pl",
  "portugal", "pt",
  "ireland", "ie",
  "new zealand", "nz",
  "brazil", "br",
  "mexico", "mx",
];

// ── Product filter sets ───────────────────────────────────────────────────────

const DIGITAL_SIGNALS = [
  "kindle edition", "kindle", "ebook", "e-book",
  "prime video", "digital", "digital download",
  "digital music", "audible", "streaming",
  "digital edition", "online game code", "game download",
  "software download", "mp3",
];

const MEDIA_TITLE_SIGNALS = [
  "blu-ray", "4k ultra hd", "[dvd]", "(dvd)", " dvd", "dvd set",
  "film collection", "movie collection", "complete series",
  "complete seasons", "the complete animated series",
  "season 1", "season 2", "season 3", "criterion collection",
  "(theatrical)", "[blu-ray]", "[4k]", "bonus features",
  "motion picture", "animated series", "anime collection",
];

const BOOK_TITLE_SIGNALS = [
  "coloring book", "art book", "illustrated history", "official history",
  "encyclopedia", "the art of", "making of", "biography", "history of",
  "pinball machine", "puzzle", "jigsaw",
];

const MEDIA_CATEGORIES = [
  "movies & tv", "blu-ray", "dvd", "amazon video", "prime video",
];

// ── Seller origin classification ──────────────────────────────────────────────

type SellerOrigin = "asia" | "japan" | "non-asia" | "unknown";

function classifySellerOrigin(shippedFrom: string, sellerName: string): SellerOrigin {
  const combined = `${shippedFrom} ${sellerName}`.toLowerCase();

  if (JAPAN_SIGNALS.some((s) => combined.includes(s))) return "japan";
  if (ASIA_NON_JAPAN_SIGNALS.some((s) => combined.includes(s))) return "asia";
  if (NON_ASIA_SIGNALS.some((s) => combined.includes(s))) return "non-asia";

  // Check for obviously US-based patterns
  if (
    shippedFrom.toLowerCase().includes("amazon") ||
    shippedFrom.toLowerCase().includes("fulfilled")
  ) {
    return "unknown"; // FBA — could be anywhere, include for review
  }

  return "unknown";
}

function originLabel(origin: SellerOrigin, shippedFrom: string): string {
  if (origin === "asia") return `Asia-based (${shippedFrom || "detected"})`;
  if (origin === "japan") return `Japan`;
  if (origin === "non-asia") return `Non-Asia (${shippedFrom || "detected"})`;
  return `Unknown origin (FBA — review required)`;
}

// ── Oxylabs helpers ───────────────────────────────────────────────────────────

async function oxylabsSearch(keyword: string, page: number, zipCode: string) {
  try {
    const resp = await fetch(OXYLABS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " + Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString("base64"),
      },
      body: JSON.stringify({
        source: "amazon_search",
        domain: "com",
        query: keyword,
        start_page: page,
        pages: 1,
        parse: true,
        geo_location: zipCode,
      }),
    });
    if (!resp.ok) {
      console.error(`Oxylabs search failed: ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    return data?.results?.[0]?.content ?? null;
  } catch (e) {
    console.error("Oxylabs search error:", e);
    return null;
  }
}

async function oxylabsProduct(asin: string, zipCode: string) {
  try {
    const resp = await fetch(OXYLABS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " + Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString("base64"),
      },
      body: JSON.stringify({
        source: "amazon_product",
        domain: "com",
        query: asin,
        parse: true,
        geo_location: zipCode,
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

// ── Product filter helpers ────────────────────────────────────────────────────

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
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\b`, "i");
  return pattern.test(title);
}

function extractSeller(content: Record<string, unknown>): { name: string; shippedFrom: string } {
  const merchant = content.featured_merchant as Record<string, string> | null;
  if (merchant?.name) {
    return { name: merchant.name, shippedFrom: merchant.shipped_from ?? "" };
  }
  const buybox = content.buybox as Record<string, string>[] | null;
  if (Array.isArray(buybox) && buybox.length > 0) {
    return { name: buybox[0].seller_name ?? "", shippedFrom: "" };
  }
  return { name: "", shippedFrom: "" };
}

function extractCategory(content: Record<string, unknown>): string {
  const catList = content.category as { ladder?: { name: string }[] }[] | null;
  if (!Array.isArray(catList) || catList.length === 0) return "";
  const ladder = catList[0].ladder ?? [];
  return ladder.map((c) => c.name).join(" > ");
}

// ── Core scan function (one keyword, all pages) ───────────────────────────────

async function scanKeyword(
  keyword: string,
  maxPages: number,
  zipCode: string,
  send: (event: string, data: object) => void
): Promise<{
  hits: object[];
  pagesScanned: number;
  productsChecked: number;
}> {
  const hits: object[] = [];
  let pagesScanned = 0;
  let productsChecked = 0;

  for (let page = 1; page <= maxPages; page++) {
    send("progress", { message: `[${keyword}] Searching page ${page}/${maxPages}...` });

    const content = await oxylabsSearch(keyword, page, zipCode);
    if (!content) {
      send("progress", { message: `[${keyword}] Page ${page}: no data, stopping.` });
      break;
    }

    pagesScanned = page;

    const resultsBlock = (content.results ?? {}) as Record<string, unknown[]>;
    const items = [
      ...((resultsBlock.organic as Record<string, unknown>[]) ?? []),
      ...((resultsBlock.amazons_choices as Record<string, unknown>[]) ?? []),
    ];

    // Pre-filter on search page (no extra API call)
    const candidates = items.filter((item) => {
      const title = (item.title as string) ?? "";
      const variations = (item.variations as { title?: string }[]) ?? [];
      if (!keywordInTitle(title, keyword)) return false;
      if (isDigital(title, variations)) return false;
      if (isMediaProduct(title, "")) return false;
      return true;
    });

    send("progress", {
      message: `[${keyword}] Page ${page}: ${items.length} products, ${candidates.length} candidates after pre-filter. Checking sellers...`,
    });

    productsChecked += candidates.length;

    // Parallel product detail fetches for this page
    const detailResults = await Promise.all(
      candidates.map(async (item) => {
        const title = (item.title as string) ?? "";
        const asin = (item.asin as string) ?? "";
        const price = item.price ?? "";
        let url = (item.url as string) ?? "";
        if (url && !url.startsWith("http")) url = "https://www.amazon.com" + url;

        const detail = await oxylabsProduct(asin, zipCode);
        if (!detail) return null;

        const detailContent = detail as Record<string, unknown>;
        const { name: seller, shippedFrom } = extractSeller(detailContent);
        const category = extractCategory(detailContent);
        const detailTitle = (detailContent.title as string) ?? title;
        const detailVariations = (detailContent.variation as { title?: string }[]) ?? [];

        // Filter: must have a seller
        if (!seller) return null;
        // Filter: not Amazon
        if (isAmazonSeller(seller)) return null;
        // Filter: not digital
        if (isDigital(detailTitle, Array.isArray(detailVariations) ? detailVariations : [])) return null;
        // Filter: not media/books
        if (isMediaProduct(detailTitle, category)) return null;

        // Seller origin check
        const origin = classifySellerOrigin(shippedFrom, seller);

        // Skip Japan sellers and clearly non-Asian sellers
        if (origin === "japan" || origin === "non-asia") {
          send("progress", {
            message: `[${keyword}] Skipped "${seller}" — ${origin === "japan" ? "Japan-based" : "non-Asia seller"}`,
          });
          return null;
        }

        // Flag asia + unknown (FBA)
        const sellerOriginLabel = originLabel(origin, shippedFrom);

        return {
          keyword,
          title: detailTitle || title,
          asin,
          seller,
          sellerOrigin: sellerOriginLabel,
          price: typeof price === "number" ? `$${price}` : String(price),
          url,
          category,
          reason:
            origin === "asia"
              ? `Asia-based third-party seller (${shippedFrom || "detected"})`
              : `Third-party seller — origin unverifiable (FBA, review required)`,
        };
      })
    );

    for (const hit of detailResults) {
      if (!hit) continue;
      hits.push(hit);
      send("candidate", {
        message: `[${keyword}] Hit: ${(hit as { title: string }).title} — Seller: ${(hit as { seller: string }).seller} (${(hit as { sellerOrigin: string }).sellerOrigin})`,
      });
    }

    // Stop if last page reached
    const lastVisiblePage = (content.last_visible_page as number) ?? page;
    if (lastVisiblePage <= page) {
      send("progress", { message: `[${keyword}] Reached last available page (${page}).` });
      break;
    }
  }

  return { hits, pagesScanned, productsChecked };
}

// ── SSE Route Handler ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();

  const campaignName: string = (body.campaignName ?? "Untitled Campaign").trim();
  // Accept keywords as array or as single string
  let keywords: string[] = [];
  if (Array.isArray(body.keywords)) {
    keywords = body.keywords.map((k: string) => k.trim()).filter(Boolean);
  } else if (typeof body.keyword === "string") {
    keywords = [body.keyword.trim()];
  }
  if (keywords.length === 0) {
    return NextResponse.json({ error: "At least one keyword is required" }, { status: 400 });
  }

  const maxPages: number = Math.min(Math.max(parseInt(body.pages ?? "20"), 1), 20);
  const zipCode: string = (body.zipCode ?? "10019").trim();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`)
        );
      };

      try {
        send("status", {
          message: `Starting campaign "${campaignName}" — ${keywords.length} keyword(s), up to ${maxPages} pages each, shipping to ZIP ${zipCode}...`,
        });

        const allHits: object[] = [];
        let totalPagesScanned = 0;
        let totalProductsChecked = 0;

        // Run keywords sequentially to avoid hammering Oxylabs
        for (const keyword of keywords) {
          send("keyword_start", { keyword });
          const { hits, pagesScanned, productsChecked } = await scanKeyword(
            keyword,
            maxPages,
            zipCode,
            send
          );
          allHits.push(...hits);
          totalPagesScanned += pagesScanned;
          totalProductsChecked += productsChecked;
          send("keyword_done", {
            keyword,
            hits: hits.length,
            message: `[${keyword}] Done — ${hits.length} hit(s) found across ${pagesScanned} pages.`,
          });
        }

        send("done", {
          report: {
            campaignName,
            claimType: "Trademark and Copyright",
            sellerScope: "Asia-based sellers (excl. Japan) on Amazon.com",
            zipCode,
            keywords,
            pages_crawled: totalPagesScanned,
            total_products_checked: totalProductsChecked,
            generatedAt: new Date().toISOString(),
            hits: allHits,
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
