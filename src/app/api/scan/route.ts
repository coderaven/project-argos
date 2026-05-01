import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// Allow up to 300s (Vercel Pro max) for long crawls
export const maxDuration = 300;

const OXYLABS_USER = process.env.OXYLABS_USER!;
const OXYLABS_PASS = process.env.OXYLABS_PASS!;
const OXYLABS_URL = "https://realtime.oxylabs.io/v1/queries";

const LLM_MODEL = "gpt-4.1-mini"; // Use gpt-4.1-mini (latest mini available)

// ── Filter sets ───────────────────────────────────────────────────────────────

const AMAZON_SELLERS = new Set([
  "amazon.com",
  "amazon export sales llc",
  "amazon digital services llc",
  "amazon media eu s.à r.l.",
  "amazon",
]);

// ── Pre-filter: ONLY the most unambiguous eliminations ───────────────────────
// Keep this list SHORT and OBVIOUS. Borderline cases go to the LLM.
// Do NOT add things like "digital", "complete series", "art of" — too aggressive.

const HARD_DIGITAL_SIGNALS = [
  "kindle edition",
  "prime video",
  "audible audiobook",
  "mp3 music",
  "digital download",
  "online game code",
  "software download",
];

const HARD_MEDIA_TITLE_SIGNALS = [
  // Physical video media — not merch
  "[blu-ray]", "(blu-ray)", "blu-ray]",
  "[dvd]", "(dvd)",
  "4k ultra hd",
  "criterion collection",
  "(theatrical edition)",
  "[4k uhd]",
];

const HARD_MEDIA_CATEGORIES = [
  // Amazon category breadcrumbs that definitively mean video media
  "prime video",
  "amazon video",
];

// ── Oxylabs helpers ───────────────────────────────────────────────────────────

async function oxylabsSearch(keyword: string, page: number, zipCode: string) {
  try {
    const resp = await fetch(OXYLABS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString("base64"),
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
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.results?.[0]?.content ?? null;
  } catch { return null; }
}

async function oxylabsProduct(asin: string, zipCode: string) {
  try {
    const resp = await fetch(OXYLABS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${OXYLABS_USER}:${OXYLABS_PASS}`).toString("base64"),
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
  } catch { return null; }
}

// ── Deterministic pre-filters ─────────────────────────────────────────────────

function isAmazonSeller(seller: string): boolean {
  return AMAZON_SELLERS.has(seller.trim().toLowerCase());
}

function isHardDigital(title: string, variations: { title?: string }[] = []): boolean {
  const t = title.toLowerCase();
  if (HARD_DIGITAL_SIGNALS.some((s) => t.includes(s))) return true;
  // Only eliminate if ALL variations are digital
  const digitalVarTypes = new Set(["kindle edition", "prime video", "audible audiobook", "mp3 music"]);
  if (variations.length > 0) {
    const allDigital = variations.every((v) => {
      const vt = (v.title ?? "").toLowerCase();
      return digitalVarTypes.has(vt);
    });
    if (allDigital) return true;
  }
  return false;
}

function isHardMedia(title: string, category: string): boolean {
  const t = title.toLowerCase();
  const c = category.toLowerCase();
  if (HARD_MEDIA_TITLE_SIGNALS.some((s) => t.includes(s))) return true;
  if (HARD_MEDIA_CATEGORIES.some((s) => c.includes(s))) return true;
  return false;
}

function keywordInTitle(title: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(title);
}

function extractSeller(content: Record<string, unknown>): { name: string; shippedFrom: string } {
  const merchant = content.featured_merchant as Record<string, string> | null;
  if (merchant?.name) return { name: merchant.name, shippedFrom: merchant.shipped_from ?? "" };
  const buybox = content.buybox as Record<string, string>[] | null;
  if (Array.isArray(buybox) && buybox.length > 0) return { name: buybox[0].seller_name ?? "", shippedFrom: "" };
  return { name: "", shippedFrom: "" };
}

function extractCategory(content: Record<string, unknown>): string {
  const catList = content.category as { ladder?: { name: string }[] }[] | null;
  if (!Array.isArray(catList) || catList.length === 0) return "";
  return (catList[0].ladder ?? []).map((c) => c.name).join(" > ");
}

// ── LLM batch assessment ──────────────────────────────────────────────────────

interface CandidateForLLM {
  asin: string;
  title: string;
  seller: string;
  shippedFrom: string;
  price: string;
  category: string;
  url: string;
  keyword: string;
}

interface LLMVerdict {
  asin: string;
  verdict: "flag" | "review" | "skip";
  confidence: number;       // 0.0 – 1.0
  sellerOrigin: string;     // LLM's best guess on where seller is based
  reasoning: string;        // Brief explanation
}

async function llmAssessBatch(
  brandKeyword: string,
  candidates: CandidateForLLM[],
  client: OpenAI
): Promise<Map<string, LLMVerdict>> {
  const resultMap = new Map<string, LLMVerdict>();
  if (candidates.length === 0) return resultMap;

  const prompt = `You are a trademark and copyright enforcement specialist helping identify potential counterfeit or unauthorized products on Amazon.

Brand/Keyword: "${brandKeyword}"
Claim Type: Trademark & Copyright Infringement

Below are Amazon product listings that passed automated pre-filters. Assess each one and determine if it is likely an unauthorized/counterfeit item, needs review, or should be skipped.

Verdict options:
- "flag": High confidence this is unauthorized/counterfeit — third-party seller with no visible authorization, suspicious pricing, generic seller names, products that seem like knock-offs
- "review": Uncertain — could be authorized reseller or counterfeit, a human should check
- "skip": Definitely NOT counterfeit — known major authorized retailer (Target, Walmart, Best Buy, GameStop, Hot Topic, etc.), clearly licensed/official merchandise with proper branding, physical media like DVDs/Blu-rays, official books/art books, or products where the brand keyword appears only incidentally (e.g. a book titled 'The Art of Godzilla' is official, not counterfeit)

IMPORTANT: Physical merchandise (toys, figures, clothing, accessories) sold by small/unknown third-party sellers with no obvious authorization signal should generally be 'flag' or 'review'. Be especially suspicious of very low prices. Books, official art books, and licensed media should be 'skip'.

For each product also guess the seller's geographic origin based on seller name patterns, pricing, and any other signals.

Products to assess:
${JSON.stringify(candidates.map(c => ({
  asin: c.asin,
  title: c.title,
  seller: c.seller,
  shipped_from: c.shippedFrom || "unknown",
  price: c.price,
  category: c.category,
})), null, 2)}

Respond ONLY with a JSON array. No extra text. Format:
[
  {
    "asin": "B0XXXXX",
    "verdict": "flag" | "review" | "skip",
    "confidence": 0.0-1.0,
    "sellerOrigin": "e.g. Likely China-based, Likely US distributor, Unknown",
    "reasoning": "One sentence explanation"
  }
]`;

  try {
    const response = await client.chat.completions.create({
      model: LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 1000,
    });

    const raw = response.choices[0].message.content ?? "[]";
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return resultMap;

    const verdicts: LLMVerdict[] = JSON.parse(match[0]);
    for (const v of verdicts) {
      if (v.asin) resultMap.set(v.asin, v);
    }
  } catch (e) {
    console.error("LLM batch assessment failed:", e);
  }

  return resultMap;
}

// ── Core scan function (one keyword, all pages) ───────────────────────────────

async function scanKeyword(
  keyword: string,
  maxPages: number,
  zipCode: string,
  client: OpenAI,
  send: (event: string, data: object) => void
): Promise<{ hits: object[]; pagesScanned: number; productsChecked: number }> {
  const hits: object[] = [];
  let pagesScanned = 0;
  let productsChecked = 0;

  for (let page = 1; page <= maxPages; page++) {
    send("progress", { message: `[${keyword}] Searching page ${page}/${maxPages}...` });

    const content = await oxylabsSearch(keyword, page, zipCode);
    if (!content) {
      send("progress", { message: `[${keyword}] Page ${page}: no data returned, stopping.` });
      break;
    }

    pagesScanned = page;

    const resultsBlock = (content.results ?? {}) as Record<string, unknown[]>;
    const items = [
      ...((resultsBlock.organic as Record<string, unknown>[]) ?? []),
      ...((resultsBlock.amazons_choices as Record<string, unknown>[]) ?? []),
    ];

    // ── Stage 1: Hard pre-filter (unambiguous eliminations only) ─────────────
    const preFiltered = items.filter((item) => {
      const title = (item.title as string) ?? "";
      const variations = (item.variations as { title?: string }[]) ?? [];
      if (!keywordInTitle(title, keyword)) return false;  // must contain keyword
      if (isHardDigital(title, variations)) return false; // definitely digital
      if (isHardMedia(title, "")) return false;           // definitely video media
      return true; // everything else goes to LLM
    });

    send("progress", {
      message: `[${keyword}] Page ${page}: ${items.length} products → ${preFiltered.length} passed pre-filter. Fetching details...`,
    });

    if (preFiltered.length === 0) {
      const lastVisiblePage = (content.last_visible_page as number) ?? page;
      if (lastVisiblePage <= page) break;
      continue;
    }

    // ── Stage 2: Parallel product detail fetch ────────────────────────────────
    const detailFetches = await Promise.all(
      preFiltered.map(async (item) => {
        const title = (item.title as string) ?? "";
        const asin = (item.asin as string) ?? "";
        const price = item.price ?? "";
        let url = (item.url as string) ?? "";
        if (url && !url.startsWith("http")) url = "https://www.amazon.com" + url;

        const detail = await oxylabsProduct(asin, zipCode);
        if (!detail) return null;

        const dc = detail as Record<string, unknown>;
        const { name: seller, shippedFrom } = extractSeller(dc);
        const category = extractCategory(dc);
        const detailTitle = (dc.title as string) ?? title;
        const detailVariations = (dc.variation as { title?: string }[]) ?? [];

        // Hard eliminators after detail fetch — still unambiguous only
        if (!seller) return null;
        if (isAmazonSeller(seller)) return null;
        if (isHardDigital(detailTitle, Array.isArray(detailVariations) ? detailVariations : [])) return null;
        if (isHardMedia(detailTitle, category)) return null;
        // NOTE: Books, coloring books, "digital camo" shirts, etc. go to LLM — not eliminated here

        return {
          asin,
          title: detailTitle || title,
          seller,
          shippedFrom,
          price: typeof price === "number" ? `$${price}` : String(price),
          category,
          url,
          keyword,
        } as CandidateForLLM;
      })
    );

    const candidates = detailFetches.filter((c): c is CandidateForLLM => c !== null);
    productsChecked += candidates.length;

    if (candidates.length === 0) {
      const lastVisiblePage = (content.last_visible_page as number) ?? page;
      if (lastVisiblePage <= page) break;
      continue;
    }

    send("progress", {
      message: `[${keyword}] Page ${page}: ${candidates.length} candidate(s) → sending to AI for assessment...`,
    });

    // ── Stage 3: LLM batch assessment ─────────────────────────────────────────
    const verdicts = await llmAssessBatch(keyword, candidates, client);

    for (const candidate of candidates) {
      const verdict = verdicts.get(candidate.asin);

      // If LLM failed for this ASIN, fall back to "review"
      const v = verdict ?? {
        verdict: "review" as const,
        confidence: 0.5,
        sellerOrigin: "Unknown (LLM unavailable)",
        reasoning: "Automated assessment unavailable — manual review recommended.",
      };

      if (v.verdict === "skip") {
        send("progress", {
          message: `[${keyword}] Skipped "${candidate.seller}" — ${v.reasoning}`,
        });
        continue;
      }

      const hit = {
        keyword: candidate.keyword,
        title: candidate.title,
        asin: candidate.asin,
        seller: candidate.seller,
        sellerOrigin: v.sellerOrigin,
        confidence: v.confidence,
        verdict: v.verdict,           // "flag" | "review"
        reasoning: v.reasoning,
        price: candidate.price,
        url: candidate.url,
        category: candidate.category,
      };
      hits.push(hit);

      const emoji = v.verdict === "flag" ? "🚨" : "⚠️";
      send("candidate", {
        message: `${emoji} [${keyword}] ${candidate.title} — Seller: ${candidate.seller} | Origin: ${v.sellerOrigin} (${Math.round(v.confidence * 100)}% confidence)`,
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
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: object) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ event, ...data })}\n\n`)
        );
      };

      try {
        send("status", {
          message: `Starting campaign "${campaignName}" — ${keywords.length} keyword(s), up to ${maxPages} pages each, ZIP ${zipCode}. Using 2-stage filter + AI assessment (${LLM_MODEL}).`,
        });

        const allHits: object[] = [];
        let totalPagesScanned = 0;
        let totalProductsChecked = 0;

        // All keywords run in parallel
        keywords.forEach((kw) => send("keyword_start", { keyword: kw }));

        const keywordResults = await Promise.all(
          keywords.map((keyword) => scanKeyword(keyword, maxPages, zipCode, client, send))
        );

        for (let i = 0; i < keywords.length; i++) {
          const { hits, pagesScanned, productsChecked } = keywordResults[i];
          allHits.push(...hits);
          totalPagesScanned += pagesScanned;
          totalProductsChecked += productsChecked;
          send("keyword_done", {
            keyword: keywords[i],
            hits: hits.length,
            message: `[${keywords[i]}] Done — ${hits.length} hit(s) across ${pagesScanned} pages.`,
          });
        }

        // Deduplicate by ASIN — keep the higher-confidence verdict if duplicate
        const asinMap = new Map<string, object>();
        for (const hit of allHits) {
          const h = hit as { asin: string; confidence: number };
          const existing = asinMap.get(h.asin) as { confidence: number } | undefined;
          if (!existing || h.confidence > existing.confidence) {
            asinMap.set(h.asin, hit);
          }
        }
        const dedupedHits = Array.from(asinMap.values());

        send("done", {
          report: {
            campaignName,
            claimType: "Trademark and Copyright",
            sellerScope: "Asia-based sellers (excl. Japan) on Amazon.com",
            zipCode,
            keywords,
            aiModel: LLM_MODEL,
            pages_crawled: totalPagesScanned,
            total_products_checked: totalProductsChecked,
            generatedAt: new Date().toISOString(),
            hits: dedupedHits,
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
