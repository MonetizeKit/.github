import { PREVIEW_MANIFEST, RESERVED_LABELS, SURFACES } from "./registry.mjs";

export { PREVIEW_MANIFEST, RESERVED_LABELS, SURFACES };

const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EDGE_CONFIG_HOST = "edge-config.vercel.com";
const EDGE_CONFIG_ID_PATTERN = /^ecfg_[a-z0-9]+$/;
const FAILED_READ_RETRY_MS = 2_000;

export function normalizeHost(host) {
  if (typeof host !== "string") return null;
  const first = host.split(",")[0].trim().toLowerCase();
  const withoutPort = first.replace(/:\d+$/, "").replace(/\.$/, "");
  return withoutPort || null;
}

export function isPreviewLabel(label) {
  return (
    typeof label === "string" &&
    LABEL_PATTERN.test(label) &&
    !RESERVED_LABELS.includes(label)
  );
}

export function parsePreviewHost(host, surfaces = SURFACES) {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  for (const [surface, definition] of Object.entries(surfaces)) {
    const suffix = `.${definition.previewBaseDomain}`;
    if (!normalized.endsWith(suffix)) continue;
    const label = normalized.slice(0, -suffix.length);
    if (isPreviewLabel(label)) return { surface, label };
  }
  return null;
}

export function previewOrigin(label, surface, surfaces = SURFACES) {
  const definition = surfaces[surface];
  if (!definition || !isPreviewLabel(label)) return null;
  return `https://${label}.${definition.previewBaseDomain}`;
}

export function manifestKey(label, surface) {
  return `${PREVIEW_MANIFEST.keyPrefix}__${label}__${surface}`;
}

export function isLiveManifestEntry(entry, { label, surface, now, surfaces = SURFACES }) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.surface !== surface) return false;
  if (entry.origin !== previewOrigin(label, surface, surfaces)) return false;
  const expiresAt = typeof entry.expiresAt === "string" ? Date.parse(entry.expiresAt) : NaN;
  return Number.isFinite(expiresAt) && expiresAt > now;
}

export function toOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim().replace(/^["']|["']$/g, ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function parseEdgeConfigConnectionString(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value.trim().replace(/^["']|["']$/g, ""));
  } catch {
    return null;
  }
  const id = url.pathname.replace(/^\//, "");
  const token = url.searchParams.get("token");
  if (url.protocol !== "https:" || url.hostname !== EDGE_CONFIG_HOST) return null;
  if (!EDGE_CONFIG_ID_PATTERN.test(id) || !token) return null;
  return { id, token };
}

export function createEdgeConfigManifestReader(
  connectionString,
  { fetch: fetchImpl = globalThis.fetch, timeoutMs = 1_500 } = {},
) {
  const parsed = parseEdgeConfigConnectionString(connectionString);
  if (!parsed || typeof fetchImpl !== "function") return null;
  return async function readManifest(keys) {
    const url = new URL(`https://${EDGE_CONFIG_HOST}/${parsed.id}/items`);
    url.searchParams.set("token", parsed.token);
    for (const key of keys) url.searchParams.append("key", key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Preview manifest read failed with HTTP ${response.status}`);
      }
      const body = await response.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body : {};
    } finally {
      clearTimeout(timer);
    }
  };
}

// Resolves every surface origin for one request host. A host that is not
// `<label>.<surface base domain>` gets the configured origins unchanged; a
// preview host gets its own origin, the manifest origin of each sibling built
// for the same change set, and the configured origin of every other sibling.
export function createSurfaceOriginResolver({
  fallbacks = {},
  readManifest = null,
  cacheTtlMs = 10_000,
  now = () => Date.now(),
  onError = () => {},
  surfaces = SURFACES,
} = {}) {
  const configured = {};
  for (const [surface, value] of Object.entries(fallbacks)) {
    const origin = toOrigin(value);
    if (origin) configured[surface] = origin;
  }
  const cache = new Map();

  async function manifestEntries(label, keys, at) {
    const cached = cache.get(label);
    if (cached && cached.expiresAt > at) return cached.values;
    let values = {};
    let ttl = cacheTtlMs;
    if (readManifest && keys.length > 0) {
      try {
        values = await readManifest(keys);
      } catch (error) {
        onError(error);
        ttl = Math.min(cacheTtlMs, FAILED_READ_RETRY_MS);
      }
    }
    cache.set(label, { values, expiresAt: at + ttl });
    return values;
  }

  return async function resolveSurfaceOrigins(host) {
    const preview = parsePreviewHost(host, surfaces);
    if (!preview) return { preview: null, origins: { ...configured } };

    const at = now();
    const origins = {
      ...configured,
      [preview.surface]: previewOrigin(preview.label, preview.surface, surfaces),
    };
    const siblings = Object.keys(surfaces).filter((surface) => surface !== preview.surface);
    const values = await manifestEntries(
      preview.label,
      siblings.map((surface) => manifestKey(preview.label, surface)),
      at,
    );
    const builtSiblings = [];
    for (const surface of siblings) {
      const entry = values[manifestKey(preview.label, surface)];
      if (isLiveManifestEntry(entry, { label: preview.label, surface, now: at, surfaces })) {
        origins[surface] = entry.origin;
        builtSiblings.push(surface);
      }
    }
    return { preview: { ...preview, builtSiblings }, origins };
  };
}
