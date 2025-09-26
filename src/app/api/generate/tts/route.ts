import { NextRequest, NextResponse } from "next/server";

import { synthesizeSpeech, type TtsAudioConfig, type TtsVoiceConfig } from "@/lib/ai/googleTts";
import { getEnv } from "@/lib/cloudflare";
import {
  ensureUser,
  getProjectById,
  insertAsset,
  insertGenerationJob,
  updateGenerationJobStatus,
} from "@/lib/db/client";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function forbidden(message: string) {
  return NextResponse.json({ error: message }, { status: 403 });
}

type SectionInput = {
  id?: string;
  heading?: string;
  text: string;
};

type RequestBody = {
  projectId: string;
  sections: SectionInput[];
  voice?: TtsVoiceConfig;
  audioConfig?: TtsAudioConfig;
};

export async function POST(request: NextRequest) {
  const userSub = request.headers.get("x-user-sub");
  const userEmail = request.headers.get("x-user-email");
  const userName = request.headers.get("x-user-name");

  if (!userSub) {
    return unauthorized();
  }

  let payload: RequestBody;
  try {
    payload = (await request.json()) as RequestBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  if (!payload.projectId) {
    return badRequest("'projectId' is required");
  }

  if (!Array.isArray(payload.sections) || payload.sections.length === 0) {
    return badRequest("'sections' must be a non-empty array");
  }

  const env = getEnv();
  const user = await ensureUser({ accessSub: userSub, email: userEmail, name: userName });
  const project = await getProjectById(payload.projectId);

  if (!project) {
    return badRequest("Project not found");
  }

  if (project.user_id !== user.id) {
    return forbidden("Project does not belong to user");
  }

  const job = await insertGenerationJob({ projectId: project.id, jobType: "tts", status: "running", payload });

  try {
    const results = [] as Array<{
      assetId: string;
      key: string;
      heading?: string;
    }>;

    for (const section of payload.sections) {
      if (!section.text || typeof section.text !== "string") {
        throw new Error("Section text is required");
      }

      const ttsResult = await synthesizeSpeech({
        input: { text: section.text },
        voice: payload.voice,
        audioConfig: payload.audioConfig,
      });

      const audioBuffer = ttsResult.audio.buffer.slice(
        ttsResult.audio.byteOffset,
        ttsResult.audio.byteOffset + ttsResult.audio.byteLength,
      ) as ArrayBuffer;

      const key = `audio/${project.id}/${crypto.randomUUID()}.mp3`;
      await env.MEDIA_BUCKET.put(key, audioBuffer, {
        httpMetadata: {
          contentType: ttsResult.mimeType,
        },
      });

      const asset = await insertAsset({
        projectId: project.id,
        type: "audio",
        label: section.heading ?? section.id ?? "Audio Segment",
        r2Key: key,
        mimeType: ttsResult.mimeType,
        sizeBytes: ttsResult.audio.byteLength,
      });

      results.push({ assetId: asset.id, key, heading: section.heading });
    }

    await updateGenerationJobStatus({ jobId: job.id, status: "succeeded" });

    return NextResponse.json({ projectId: project.id, assets: results });
  } catch (cause: unknown) {
    await updateGenerationJobStatus({
      jobId: job.id,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Unknown error",
    });
    console.error("Failed to generate TTS", cause);
    return NextResponse.json({ error: "Failed to generate audio" }, { status: 500 });
  }
}
