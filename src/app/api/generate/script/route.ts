import { NextRequest, NextResponse } from "next/server";

import { generateYoutubeScript } from "@/lib/ai/gemini";
import { getEnv } from "@/lib/cloudflare";
import {
  createProject,
  ensureUser,
  getProjectById,
  insertGenerationJob,
  insertProjectVersion,
  updateGenerationJobStatus,
  updateProjectMetadata,
} from "@/lib/db/client";
import { sha256 } from "@/lib/utils/hash";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function forbidden(message: string) {
  return NextResponse.json({ error: message }, { status: 403 });
}

type RequestBody = {
  topic: string;
  persona?: string;
  lengthMinutes?: number;
  language?: string;
  projectId?: string;
  regenerate?: boolean;
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

  if (!payload.topic || typeof payload.topic !== "string") {
    return badRequest("'topic' is required");
  }

  const env = getEnv();
  const user = await ensureUser({ accessSub: userSub, email: userEmail, name: userName });
  const geminiModel = env.GEMINI_MODEL ?? "gemini-2.0-flash-lite-preview-02-05";

  let projectId = payload.projectId;
  if (projectId) {
    const project = await getProjectById(projectId);
    if (!project) {
      return badRequest("Project not found");
    }
    if (project.user_id !== user.id) {
      return forbidden("Project does not belong to user");
    }
  } else {
    const project = await createProject({ userId: user.id, topic: payload.topic, title: payload.topic });
    projectId = project.id;
  }

  const cacheBase = JSON.stringify({
    topic: payload.topic,
    persona: payload.persona ?? null,
    length: payload.lengthMinutes ?? null,
    language: payload.language ?? null,
  });
  const cacheKey = `script:${await sha256(cacheBase)}`;

  if (!payload.regenerate) {
    const cached = await env.CACHE.get<unknown>(cacheKey, { type: "json" });
    if (cached) {
      return NextResponse.json({
        projectId,
        cached: true,
        result: cached,
      });
    }
  }

  const job = await insertGenerationJob({ projectId, jobType: "script", status: "running", payload });

  try {
    const result = await generateYoutubeScript({
      topic: payload.topic,
      persona: payload.persona,
      lengthMinutes: payload.lengthMinutes,
      language: payload.language,
    });

    await insertProjectVersion({
      projectId,
      outline: result.outline,
      script: result.sections,
      seo: result.seo,
      generatedWith: {
        provider: "gemini",
        model: geminiModel,
      },
    });

    await updateProjectMetadata(projectId, {
      topic: payload.topic,
      title: result.seo.title,
      status: "ready",
    });

    await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 6 });
    await updateGenerationJobStatus({ jobId: job.id, status: "succeeded" });

    return NextResponse.json({ projectId, cached: false, result });
  } catch (cause: unknown) {
    await updateGenerationJobStatus({
      jobId: job.id,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Unknown error",
    });
    console.error("Failed to generate script", cause);
    return NextResponse.json({ error: "Failed to generate script" }, { status: 500 });
  }
}
