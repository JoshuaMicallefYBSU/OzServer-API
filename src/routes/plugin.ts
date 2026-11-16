import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import { createReleaseSource, selectRelease } from "../plugin-release.js";

export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  const source = createReleaseSource(config.PLUGIN_RELEASE_REPO);

  // The release the plugin's updater should install, or null when there is none to offer. Public:
  // it is asked before a controller has connected to anything, and says nothing the repository's
  // own releases page does not.
  app.get("/plugin/release", async (_request, reply) => {
    const releases = await source.releases();
    // Not the same as "no release": the plugin answers a 503 by asking GitHub itself.
    if (releases === null) {
      return reply.code(503).header("Retry-After", "60").send({ message: "The plugin release list is not available yet." });
    }
    reply.header("Cache-Control", "public, max-age=60");
    return selectRelease(releases, { repo: config.PLUGIN_RELEASE_REPO, maxVersion: config.PLUGIN_RELEASE_MAX_VERSION ?? null });
  });
}
