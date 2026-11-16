import { describe, expect, it } from "vitest";
import { compareVersions, createReleaseSource, parseVersion, selectRelease } from "./plugin-release.js";

const repo = "example/plugin";
const dll = (tag: string, extra: Record<string, unknown> = {}) => ({
  name: "OzServerPlugin.dll",
  size: 1234,
  digest: `sha256:${"ab".repeat(32)}`,
  browser_download_url: `https://github.com/${repo}/releases/download/${tag}/OzServerPlugin.dll`,
  ...extra
});
const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: true,
  published_at: "2026-11-11T10:28:16Z",
  html_url: `https://github.com/${repo}/releases/tag/${tag}`,
  assets: [dll(tag)],
  ...extra
});

describe("parseVersion", () => {
  it("reads a tag with or without its leading v", () => {
    expect(parseVersion("v0.1.8")).toEqual([0, 1, 8, 0]);
    expect(parseVersion("0.1.8.2")).toEqual([0, 1, 8, 2]);
    expect(parseVersion("1.0")).toEqual([1, 0, 0, 0]);
  });

  it("refuses anything that is not a version", () => {
    for (const value of ["latest", "v1", "1.2.3-beta", "", null, 12]) expect(parseVersion(value)).toBeNull();
  });

  it("orders numerically, not as text", () => {
    expect(compareVersions(parseVersion("0.1.10")!, parseVersion("0.1.9")!)).toBeGreaterThan(0);
    expect(compareVersions(parseVersion("0.1.8")!, parseVersion("0.1.8.0")!)).toBe(0);
  });
});

describe("selectRelease", () => {
  it("offers the highest version, whatever order GitHub lists them in", () => {
    const chosen = selectRelease([release("v0.1.9"), release("v0.1.10"), release("v0.1.8")], { repo });
    expect(chosen).toMatchObject({
      version: "0.1.10",
      tag: "v0.1.10",
      url: `https://github.com/${repo}/releases/download/v0.1.10/OzServerPlugin.dll`,
      sha256: "ab".repeat(32),
      size: 1234
    });
  });

  it("counts a prerelease and skips a draft", () => {
    const chosen = selectRelease([release("v0.2.0", { draft: true }), release("v0.1.8")], { repo });
    expect(chosen?.version).toBe("0.1.8");
  });

  it("skips a release with no plugin DLL attached", () => {
    const zipOnly = release("v0.2.0", { assets: [{ name: "OzServerPlugin-v0.2.0.zip", browser_download_url: "x" }] });
    expect(selectRelease([zipOnly, release("v0.1.8")], { repo })?.version).toBe("0.1.8");
  });

  it("never offers a download from outside the repository's releases", () => {
    const elsewhere = release("v0.2.0", {
      assets: [dll("v0.2.0", { browser_download_url: "https://example.com/OzServerPlugin.dll" })]
    });
    expect(selectRelease([elsewhere], { repo })).toBeNull();
  });

  it("holds back anything newer than maxVersion", () => {
    const releases = [release("v0.1.10"), release("v0.1.9"), release("v0.1.8")];
    expect(selectRelease(releases, { repo, maxVersion: "0.1.9" })?.version).toBe("0.1.9");
    expect(selectRelease(releases, { repo, maxVersion: "v0.1.7" })).toBeNull();
  });

  it("serves no digest for an asset that has none", () => {
    const old = release("v0.1.4", { assets: [dll("v0.1.4", { digest: null })] });
    expect(selectRelease([old], { repo })?.sha256).toBeNull();
  });

  it("answers null for a body that is not a release list", () => {
    expect(selectRelease({ message: "Not Found" }, { repo })).toBeNull();
    expect(selectRelease([], { repo })).toBeNull();
  });
});

describe("createReleaseSource", () => {
  const response = (status: number, body: unknown = null, etag: string | null = null) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => name.toLowerCase() === "etag" ? etag : null },
    json: async () => body
  });

  it("fetches once and serves the cached list afterwards", async () => {
    let calls = 0;
    const source = createReleaseSource(repo, async () => { calls++; return response(200, [release("v0.1.8")], '"abc"'); });
    expect(await source.releases()).toHaveLength(1);
    expect(await source.releases()).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it("shares one request between callers that arrive together", async () => {
    let calls = 0;
    const source = createReleaseSource(repo, async () => { calls++; return response(200, []); });
    await Promise.all([source.releases(), source.releases(), source.releases()]);
    expect(calls).toBe(1);
  });

  it("answers null, not an empty list, when GitHub has never been reached", async () => {
    const source = createReleaseSource(repo, async () => { throw new Error("offline"); });
    expect(await source.releases()).toBeNull();
    const refused = createReleaseSource(repo, async () => response(403));
    expect(await refused.releases()).toBeNull();
  });
});
