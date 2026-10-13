export interface SurfaceDefinition {
  readonly repository: string;
  readonly vercelProjectId: string;
  readonly previewBaseDomain: string;
}

export type SurfaceRegistry = Readonly<Record<string, SurfaceDefinition>>;

export declare const SURFACES: SurfaceRegistry;

export declare const PREVIEW_MANIFEST: Readonly<{
  vercelTeamId: string;
  edgeConfigId: string;
  keyPrefix: string;
  maxLifetimeMs: number;
}>;

export declare const RESERVED_LABELS: readonly string[];

export interface PreviewHost {
  surface: string;
  label: string;
}

export interface ManifestEntry {
  repository: string;
  surface: string;
  vercelProjectId: string;
  deploymentId: string;
  origin: string;
  branch: string;
  sha: string;
  pullRequest: number | null;
  updatedAt: string;
  expiresAt: string;
}

export type ManifestReader = (keys: string[]) => Promise<Record<string, unknown>>;

export interface ResolvedSurfaceOrigins {
  preview: (PreviewHost & { builtSiblings: string[] }) | null;
  origins: Record<string, string>;
}

export interface SurfaceOriginResolverOptions {
  fallbacks?: Record<string, string | null | undefined>;
  readManifest?: ManifestReader | null;
  cacheTtlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  surfaces?: SurfaceRegistry;
}

export declare function normalizeHost(host: string | null | undefined): string | null;
export declare function isPreviewLabel(label: unknown): label is string;
export declare function parsePreviewHost(
  host: string | null | undefined,
  surfaces?: SurfaceRegistry,
): PreviewHost | null;
export declare function previewOrigin(
  label: string,
  surface: string,
  surfaces?: SurfaceRegistry,
): string | null;
export declare function manifestKey(label: string, surface: string): string;
export declare function isLiveManifestEntry(
  entry: unknown,
  options: { label: string; surface: string; now: number; surfaces?: SurfaceRegistry },
): entry is ManifestEntry;
export declare function toOrigin(value: string | null | undefined): string | null;
export declare function parseEdgeConfigConnectionString(
  value: string | null | undefined,
): { id: string; token: string } | null;
export declare function createEdgeConfigManifestReader(
  connectionString: string | null | undefined,
  options?: { fetch?: typeof fetch; timeoutMs?: number },
): ManifestReader | null;
export declare function createSurfaceOriginResolver(
  options?: SurfaceOriginResolverOptions,
): (host: string | null | undefined) => Promise<ResolvedSurfaceOrigins>;
