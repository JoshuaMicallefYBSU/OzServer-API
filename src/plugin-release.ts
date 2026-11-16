// The plugin release every client should be running, read from the plugin repository's GitHub
// releases and cached here. Clients ask this API rather than GitHub, so one server-side request
// every few minutes replaces a GitHub API call from every controller, and the release on offer can
// be held back centrally (PLUGIN_RELEASE_MAX_VERSION).
//
// Only the answer is served from here. The binary is still downloaded from GitHub, and the plugin
// accepts a download URL under its own repository's releases only - so this API can choose which
// published release is offered, but cannot point a client at anything else.
//
// Free of config and database imports so it can be unit tested on its own.

const ASSET_NAME = "OzServerPlugin.dll";
const REFRESH_MS = 5 * 60_000;
// After a failed refresh. Short enough to recover promptly, long enough that an outage at GitHub is
// not met with a request per caller.
const RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type PluginRelease = {
  version: string;
  tag: string;
  url: string;
  // Hex SHA-256 of the asset, as GitHub reports it. Null for an asset uploaded before GitHub
  // recorded digests.
  sha256: string | null;
  size: number | null;
  published_at: string | null;
  notes_url: string | null;
};

type Version = [number, number, number, number];

// "v0.1.8", "0.1.8" or "0.1.8.0". Anything else is not a version this API will offer.
export function parseVersion(value: unknown): Version | null {
  if (typeof value !== "string") return null;
  const match = /^v?(\d{1,5})\.(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
}

export function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 4; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

// Three parts unless a fourth is in use, matching how releases are tagged.
const formatVersion = (version: Version): string =>
  (version[3] === 0 ? version.slice(0, 3) : version).join(".");

// The newest published release that carries the plugin DLL, optionally capped at maxVersion.
// Prereleases count: every release so far has been published as one. Drafts never do.
export function selectRelease(
  releases: unknown,
  options: { repo: string; maxVersion?: string | null }
): PluginRelease | null {
  if (!Array.isArray(releases)) return null;
  const ceiling = options.maxVersion ? parseVersion(options.maxVersion) : null;
  const downloadPrefix = `https://github.com/${options.repo}/releases/download/`.toLowerCase();

  let best: { version: Version; release: PluginRelease } | null = null;
  for (const entry of releases as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object" || entry.draft === true) continue;
    const version = parseVersion(entry.tag_name);
    if (!version) continue;
    if (ceiling && compareVersions(version, ceiling) > 0) continue;
    if (best && compareVersions(version, best.version) <= 0) continue;

    const assets = Array.isArray(entry.assets) ? entry.assets as Array<Record<string, unknown>> : [];
    const asset = assets.find(candidate =>
      typeof candidate?.name === "string" && candidate.name.toLowerCase() === ASSET_NAME.toLowerCase());
    const url = asset?.browser_download_url;
    if (typeof url !== "string" || !url.toLowerCase().startsWith(downloadPrefix)) continue;

    const digest = typeof asset?.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
    best = {
      version,
      release: {
        version: formatVersion(version),
        tag: String(entry.tag_name),
        url,
        sha256: digest ? digest[1]!.toLowerCase() : null,
        size: typeof asset?.size === "number" ? asset.size : null,
        published_at: typeof entry.published_at === "string" ? entry.published_at : null,
        notes_url: typeof entry.html_url === "string" ? entry.html_url : null
      }
    };
  }
  return best?.release ?? null;
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

// A cached view of one repository's releases. `releases()` resolves to the release list, or null
// when GitHub has never been reached - a caller can then say "unknown" instead of "none".
export function createReleaseSource(repo: string, fetcher: Fetch = fetch as unknown as Fetch) {
  let cache: { releases: unknown; etag: string | null } | null = null;
  let nextRefreshAt = 0;
  let inFlight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "ozserver-api",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      // A conditional request answered 304 does not count against GitHub's rate limit.
      if (cache?.etag) headers["If-None-Match"] = cache.etag;
      const response = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=30`,
        { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status === 304 && cache) {
        nextRefreshAt = Date.now() + REFRESH_MS;
        return;
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      cache = { releases: await response.json(), etag: response.headers.get("etag") };
      nextRefreshAt = Date.now() + REFRESH_MS;
    } catch {
      // Whatever was last read keeps being served; the next caller after RETRY_MS tries again.
      nextRefreshAt = Date.now() + RETRY_MS;
    }
  }

  return {
    async releases(): Promise<unknown | null> {
      if (Date.now() >= nextRefreshAt) {
        // One refresh at a time, however many callers arrive while it is running.
        inFlight ??= refresh().finally(() => { inFlight = null; });
        // A caller is only made to wait when there is nothing to serve in the meantime.
        if (!cache) await inFlight;
      }
      return cache ? cache.releases : null;
    }
  };
}
