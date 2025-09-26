import { getEnv as getOptionalEnv, requireEnv } from "@/lib/env";

export type GeminiScriptSection = {
  heading: string;
  narration: string;
  brollIdeas?: string[];
  durationSeconds?: number;
};

export type GeminiSeo = {
  title: string;
  description: string;
  tags: string[];
};

export type GeminiResponse = {
  outline: string[];
  sections: GeminiScriptSection[];
  seo: GeminiSeo;
  thumbnailIdeas: string[];
};

type GenerateScriptParams = {
  topic: string;
  persona?: string;
  lengthMinutes?: number;
  language?: string;
};

function buildPrompt(params: GenerateScriptParams): string {
  const persona = params.persona ?? "engaging, informative, and energetic";
  const targetLength = params.lengthMinutes ?? 8;
  const language = params.language ?? "English";

  return `You are an expert YouTube content strategist and scriptwriter. Create a complete plan for a video about "${params.topic}".

Requirements:
- Audience persona: ${persona}.
- Target runtime: ${targetLength} minutes.
- Language: ${language}.
- Provide 6-10 sequential sections that map to the video flow.
- Each section includes:
  * "heading": 3-6 word hook for the chapter card.
  * "narration": friendly narration script, 2-4 sentences per section.
  * "brollIdeas": optional bullet suggestions for supporting visuals.
  * "durationSeconds": estimated runtime for that section.
- Provide an ordered "outline" array listing each section heading.
- Provide "seo" metadata with "title" (<= 70 chars), "description" (<= 150 words), and 12-18 relevant "tags" optimized for YouTube search.
- Include 3-5 distinct "thumbnailIdeas" summarizing standout visual concepts.

Respond ONLY with minified JSON following this schema:
{
  "outline": string[],
  "sections": { "heading": string, "narration": string, "brollIdeas"?: string[], "durationSeconds"?: number }[],
  "seo": { "title": string, "description": string, "tags": string[] },
  "thumbnailIdeas": string[]
}`;
}

function getGeminiEndpoint(): string {
  const model = getOptionalEnv("GEMINI_MODEL") ?? "gemini-2.0-flash-lite-preview-02-05";
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

type GeminiApiCandidate = {
  content?: {
    parts?: Array<{ text?: string }>;
  };
  output_text?: string;
};

type GeminiApiResponse = {
  candidates?: GeminiApiCandidate[];
};

function parseGeminiResponse(raw: unknown): GeminiResponse {
  if (!raw || typeof raw !== "object") {
    throw new Error("Gemini response missing");
  }

  const { candidates } = raw as GeminiApiResponse;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("Gemini returned no candidates");
  }

  const parts = candidates[0]?.content?.parts;
  const textPart = Array.isArray(parts)
    ? parts.find((part) => typeof part?.text === "string") ?? null
    : null;
  const text = textPart?.text ?? candidates[0]?.output_text;

  if (!text || typeof text !== "string") {
    throw new Error("Gemini response missing text part");
  }

  try {
    const parsed = JSON.parse(text) as GeminiResponse;
    if (!parsed.outline || !parsed.sections || !parsed.seo || !parsed.thumbnailIdeas) {
      throw new Error("Gemini response incomplete");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse Gemini JSON: ${(error as Error).message}`);
  }
}

export async function generateYoutubeScript(params: GenerateScriptParams): Promise<GeminiResponse> {
  const apiKey = requireEnv("GOOGLE_GEMINI_API_KEY");

  const prompt = buildPrompt(params);
  const response = await fetch(`${getGeminiEndpoint()}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.65,
        topK: 40,
        topP: 0.8,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return parseGeminiResponse(data);
}
