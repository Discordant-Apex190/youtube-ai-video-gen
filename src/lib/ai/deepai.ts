import { requireEnv } from "@/lib/env";

export type DeepAiImageParams = {
  prompt: string;
  style?: string;
  aspectRatio?: string;
};

export type DeepAiImageResult = {
  url: string;
  id: string;
};

export async function generateImage(params: DeepAiImageParams): Promise<Response> {
  const apiKey = requireEnv("DEEPAI_API_KEY");
  const formData = new FormData();
  formData.append("text", params.prompt);
  if (params.style) formData.append("style", params.style);
  if (params.aspectRatio) formData.append("grid_size", params.aspectRatio);

  const response = await fetch("https://api.deepai.org/api/text2img", {
    method: "POST",
    headers: {
      "api-key": apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepAI request failed: ${response.status} ${text}`);
  }

  const payload = (await response.json()) as { output_url?: string; id?: string };
  if (!payload.output_url) {
    throw new Error("DeepAI response missing output_url");
  }

  const imageResponse = await fetch(payload.output_url);
  if (!imageResponse.ok) {
    throw new Error(`Failed to fetch DeepAI image asset: ${imageResponse.status}`);
  }

  return new Response(imageResponse.body, {
    headers: imageResponse.headers,
  });
}
