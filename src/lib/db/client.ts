import { getEnv } from "@/lib/cloudflare";

export type DBUser = {
  id: string;
  access_sub: string;
  email: string | null;
  name: string | null;
  created_at: string;
};

export type DBProject = {
  id: string;
  user_id: string;
  title: string | null;
  topic: string | null;
  target_length: number | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type DBProjectVersion = {
  id: string;
  project_id: string;
  version: number;
  script: string;
  outline: string;
  seo: string;
  generated_with: string | null;
  created_at: string;
};

export type DBAsset = {
  id: string;
  project_id: string;
  type: string;
  label: string | null;
  r2_key: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

export type DBGenerationJob = {
  id: string;
  project_id: string;
  job_type: string;
  status: string;
  payload: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ScriptSectionRecord = {
  heading: string;
  narration: string;
  brollIdeas?: string[];
  durationSeconds?: number;
};

export type SeoMetadataRecord = {
  title: string;
  description: string;
  tags: string[];
};

export type ProjectVersionMetadata = {
  provider?: string;
  model?: string;
  thumbnailIdeas?: string[];
  persona?: string;
  lengthMinutes?: number;
  language?: string;
  [key: string]: unknown;
} | null;

export type ProjectVersionRecord = {
  id: string;
  project_id: string;
  version: number;
  sections: ScriptSectionRecord[];
  outline: string[];
  seo: SeoMetadataRecord;
  generatedMetadata: ProjectVersionMetadata;
  created_at: string;
};

export type GenerationJobRecord = Omit<DBGenerationJob, "payload"> & {
  payload: unknown;
};

export type ProjectListItem = {
  project: DBProject;
  latestVersion: ProjectVersionRecord | null;
  assetCounts: Record<string, number>;
};

export type ProjectDetailRecord = {
  project: DBProject;
  latestVersion: ProjectVersionRecord | null;
  versions: ProjectVersionRecord[];
  assets: DBAsset[];
  generationJobs: GenerationJobRecord[];
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    console.error("Failed to parse JSON value", error);
    return fallback;
  }
}

function parseProjectVersionRow(row: DBProjectVersion): ProjectVersionRecord {
  const outline = parseJson<string[]>(row.outline, []);
  const sections = parseJson<ScriptSectionRecord[]>(row.script, []);
  const rawSeo = parseJson<Partial<SeoMetadataRecord>>(row.seo, {});
  const seo: SeoMetadataRecord = {
    title: typeof rawSeo.title === "string" ? rawSeo.title : "",
    description: typeof rawSeo.description === "string" ? rawSeo.description : "",
    tags: Array.isArray(rawSeo.tags)
      ? rawSeo.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
  };

  const generatedMetadata = parseJson<ProjectVersionMetadata>(row.generated_with, null);

  return {
    id: row.id,
    project_id: row.project_id,
    version: row.version,
    sections,
    outline,
    seo,
    generatedMetadata,
    created_at: row.created_at,
  };
}

export async function ensureUser(params: {
  accessSub: string;
  email?: string | null;
  name?: string | null;
}): Promise<DBUser> {
  const env = getEnv();
  const existing = await env.DB.prepare(
    `SELECT id, access_sub, email, name, created_at FROM users WHERE access_sub = ?`
  )
    .bind(params.accessSub)
    .first<DBUser>();

  if (existing) {
    if (params.email || params.name) {
      await env.DB.prepare(`UPDATE users SET email = coalesce(?, email), name = coalesce(?, name) WHERE id = ?`)
        .bind(params.email ?? null, params.name ?? null, existing.id)
        .run();
      return {
        ...existing,
        email: params.email ?? existing.email,
        name: params.name ?? existing.name,
      };
    }
    return existing;
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, access_sub, email, name, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  )
    .bind(id, params.accessSub, params.email ?? null, params.name ?? null)
    .run();

  const inserted = await env.DB.prepare(
    `SELECT id, access_sub, email, name, created_at FROM users WHERE id = ?`
  )
    .bind(id)
    .first<DBUser>();

  if (!inserted) {
    throw new Error("Failed to insert user");
  }

  return inserted;
}

export async function getProjectById(projectId: string): Promise<DBProject | null> {
  const env = getEnv();
  return env.DB.prepare(
    `SELECT id, user_id, title, topic, target_length, status, created_at, updated_at
     FROM projects WHERE id = ?`
  )
    .bind(projectId)
    .first<DBProject>();
}

export async function createProject(params: {
  userId: string;
  title?: string | null;
  topic?: string | null;
  targetLength?: number | null;
}): Promise<DBProject> {
  const env = getEnv();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO projects (id, user_id, title, topic, target_length, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', datetime('now'), datetime('now'))`
  )
    .bind(id, params.userId, params.title ?? null, params.topic ?? null, params.targetLength ?? null)
    .run();

  const project = await getProjectById(id);
  if (!project) throw new Error("Failed to create project");
  return project;
}

export async function updateProjectMetadata(
  projectId: string,
  metadata: {
    title?: string | null;
    topic?: string | null;
    status?: string;
  }
): Promise<void> {
  const env = getEnv();
  await env.DB.prepare(
    `UPDATE projects
     SET title = coalesce(?, title),
         topic = coalesce(?, topic),
         status = coalesce(?, status),
         updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(metadata.title ?? null, metadata.topic ?? null, metadata.status ?? null, projectId)
    .run();
}

export async function insertProjectVersion(params: {
  projectId: string;
  outline: unknown;
  script: unknown;
  seo: unknown;
  generatedMetadata?: unknown;
}): Promise<DBProjectVersion> {
  const env = getEnv();
  const lastVersion = await env.DB.prepare(
    `SELECT version FROM project_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`
  )
    .bind(params.projectId)
    .first<{ version: number }>();

  const nextVersion = (lastVersion?.version ?? 0) + 1;
  const id = crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO project_versions (id, project_id, version, script, outline, seo, generated_with, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      id,
      params.projectId,
      nextVersion,
      JSON.stringify(params.script),
      JSON.stringify(params.outline),
      JSON.stringify(params.seo),
      params.generatedMetadata ? JSON.stringify(params.generatedMetadata) : null,
    )
    .run();

  const inserted = await env.DB.prepare(
    `SELECT id, project_id, version, script, outline, seo, generated_with, created_at
     FROM project_versions WHERE id = ?`
  )
    .bind(id)
    .first<DBProjectVersion>();

  if (!inserted) throw new Error("Failed to insert project version");
  return inserted;
}

export async function insertGenerationJob(params: {
  projectId: string;
  jobType: "script" | "tts" | "image";
  status?: "queued" | "running" | "succeeded" | "failed";
  payload?: unknown;
}): Promise<DBGenerationJob> {
  const env = getEnv();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO generation_jobs (id, project_id, job_type, status, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  )
    .bind(id, params.projectId, params.jobType, params.status ?? "queued", JSON.stringify(params.payload ?? null))
    .run();

  const job = await env.DB.prepare(
    `SELECT id, project_id, job_type, status, payload, error, created_at, updated_at
     FROM generation_jobs WHERE id = ?`
  )
    .bind(id)
    .first<DBGenerationJob>();

  if (!job) throw new Error("Failed to insert generation job");
  return job;
}

export async function updateGenerationJobStatus(params: {
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error?: string | null;
}): Promise<void> {
  const env = getEnv();
  await env.DB.prepare(
    `UPDATE generation_jobs
     SET status = ?,
         error = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(params.status, params.error ?? null, params.jobId)
    .run();
}

export async function insertAsset(params: {
  projectId: string;
  type: "audio" | "image" | "export";
  label?: string | null;
  r2Key: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
}): Promise<DBAsset> {
  const env = getEnv();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO assets (id, project_id, type, label, r2_key, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(
      id,
      params.projectId,
      params.type,
      params.label ?? null,
      params.r2Key,
      params.mimeType ?? null,
      params.sizeBytes ?? null,
    )
    .run();

  const asset = await env.DB.prepare(
    `SELECT id, project_id, type, label, r2_key, mime_type, size_bytes, created_at
     FROM assets WHERE id = ?`
  )
    .bind(id)
    .first<DBAsset>();

  if (!asset) throw new Error("Failed to insert asset");
  return asset;
}

export async function getProjectVersions(projectId: string): Promise<ProjectVersionRecord[]> {
  const env = getEnv();
  const { results } = await env.DB.prepare(
    `SELECT id, project_id, version, script, outline, seo, generated_with, created_at
     FROM project_versions WHERE project_id = ? ORDER BY version DESC`
  )
    .bind(projectId)
    .all<DBProjectVersion>();

  return (results ?? []).map(parseProjectVersionRow);
}

export async function getLatestProjectVersion(projectId: string): Promise<ProjectVersionRecord | null> {
  const env = getEnv();
  const row = await env.DB.prepare(
    `SELECT id, project_id, version, script, outline, seo, generated_with, created_at
     FROM project_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1`
  )
    .bind(projectId)
    .first<DBProjectVersion>();

  return row ? parseProjectVersionRow(row) : null;
}

export async function listAssetsForProject(projectId: string): Promise<DBAsset[]> {
  const env = getEnv();
  const { results } = await env.DB.prepare(
    `SELECT id, project_id, type, label, r2_key, mime_type, size_bytes, created_at
     FROM assets WHERE project_id = ? ORDER BY created_at DESC`
  )
    .bind(projectId)
    .all<DBAsset>();

  return results ?? [];
}

export async function listGenerationJobsForProject(projectId: string): Promise<GenerationJobRecord[]> {
  const env = getEnv();
  const { results } = await env.DB.prepare(
    `SELECT id, project_id, job_type, status, payload, error, created_at, updated_at
     FROM generation_jobs WHERE project_id = ? ORDER BY created_at DESC`
  )
    .bind(projectId)
    .all<DBGenerationJob>();

  return (results ?? []).map((row) => ({
    ...row,
    payload: parseJson(row.payload, null),
  }));
}

export async function listProjectsForUser(userId: string): Promise<ProjectListItem[]> {
  const env = getEnv();
  const { results } = await env.DB.prepare(
    `SELECT id, user_id, title, topic, target_length, status, created_at, updated_at
     FROM projects WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(userId)
    .all<DBProject>();

  const projects = results ?? [];
  const items: ProjectListItem[] = [];

  for (const project of projects) {
    const latestVersion = await getLatestProjectVersion(project.id);
    const assetCountsStatement = await env.DB.prepare(
      `SELECT type, COUNT(*) as count FROM assets WHERE project_id = ? GROUP BY type`
    )
      .bind(project.id)
      .all<{ type: string; count: number }>();

    const counts: Record<string, number> = {};
    for (const row of assetCountsStatement.results ?? []) {
      counts[row.type] = Number(row.count ?? 0);
    }

    items.push({ project, latestVersion, assetCounts: counts });
  }

  return items;
}

export async function getProjectDetail(projectId: string): Promise<ProjectDetailRecord | null> {
  const project = await getProjectById(projectId);
  if (!project) return null;

  const [versions, assets, generationJobs] = await Promise.all([
    getProjectVersions(projectId),
    listAssetsForProject(projectId),
    listGenerationJobsForProject(projectId),
  ]);

  return {
    project,
    latestVersion: versions[0] ?? null,
    versions,
    assets,
    generationJobs,
  };
}
