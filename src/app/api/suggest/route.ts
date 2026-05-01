import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(req: NextRequest) {
  const { keyword } = await req.json();
  if (!keyword?.trim()) {
    return NextResponse.json({ error: "keyword is required" }, { status: 400 });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `You are a trademark enforcement specialist. Your job is to generate keyword variants that counterfeiters and IP infringers commonly use to evade Amazon search filters and trademark detection when selling fake or unauthorized products.

Given a brand or keyword, generate realistic obfuscated variants that:
- Use character substitutions (0 for o, 1 for i, 3 for e, @ for a, ! for i, etc.)
- Use hyphens, spaces, dots, or underscores inserted mid-word
- Use phonetic misspellings or common typos
- Combine numbers and special characters to look like the brand
- May add common suffixes/prefixes counterfeiters use

Return ONLY a JSON array of strings — no explanation, no markdown, no extra text.
Return between 5 and 10 variants. Do not include the original keyword.
Example for "Nike": ["N1ke", "N-ike", "Nik3", "N!ke", "Niike", "NlKE", "N.ike", "Nke"]`,
      },
      {
        role: "user",
        content: `Generate keyword variants for: "${keyword.trim()}"`,
      },
    ],
    temperature: 0.7,
    max_tokens: 300,
  });

  const raw = response.choices[0].message.content ?? "[]";

  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const suggestions: string[] = match ? JSON.parse(match[0]) : [];
    return NextResponse.json({ suggestions: suggestions.filter(Boolean) });
  } catch {
    return NextResponse.json({ suggestions: [] });
  }
}
