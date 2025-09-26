import { NextRequest, NextResponse } from "next/server";

import { generateImage } from "@/lib/ai/deepai";
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

type RequestBody = {
  projectId: string;
  prompt: string;
  style?: string;
  aspectRatio?: string;
  label?: string;
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

  if (!payload.prompt) {
    return badRequest("'prompt' is required");
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

  const job = await insertGenerationJob({ projectId: project.id, jobType: "image", status: "running", payload });

  try {
    const imageResponse = await generateImage({
      prompt: payload.prompt,
      style: payload.style,
      aspectRatio: payload.aspectRatio,
    });

    const contentType = imageResponse.headers.get("content-type") ?? "image/png";
    const extension = contentType.split("/")[1] ?? "png";
    const arrayBuffer = await imageResponse.arrayBuffer();
    const key = `images/${project.id}/${crypto.randomUUID()}.${extension}`;

    await env.MEDIA_BUCKET.put(key, arrayBuffer, {
      httpMetadata: {
        contentType,
      },
    });

    const asset = await insertAsset({
      projectId: project.id,
      type: "image",
      label: payload.label ?? payload.prompt.slice(0, 64),
      r2Key: key,
      mimeType: contentType,
      sizeBytes: arrayBuffer.byteLength,
    });

    await updateGenerationJobStatus({ jobId: job.id, status: "succeeded" });

    return NextResponse.json({ projectId: project.id, assetId: asset.id, key });
  } catch (cause: unknown) {
    await updateGenerationJobStatus({
      jobId: job.id,
      status: "failed",
      error: cause instanceof Error ? cause.message : "Unknown error",
    });
    console.error("Failed to generate image", cause);
    return NextResponse.json({ error: "Failed to generate image" }, { status: 500 });
  }
}
