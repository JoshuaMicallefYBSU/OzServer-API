// The pure half of live-stats.ts: which FIR a sector is in, and the Discord embeds built from a
// snapshot of the network. Free of config and database imports so it can be unit tested.

// A record no client has reported for this long is not "on the network now", even though it is kept
// for FDR_RETAIN_MINUTES in case its pilot reconnects.
export const RECENT_MINUTES = 3;
// A plugin call this recent marks a controller as running OzServer (plugin_clients).
export const PLUGIN_RECENT_MINUTES = 2;
export const REQUEST_TIMEOUT_MS = 10_000;
// Discord's limits are 4096 (description) and 1024 (field value); kept under for the "and N more".
const DESCRIPTION_LIMIT = 3_900;
const FIELD_LIMIT = 1_000;
const MAX_FIELDS = 25;

const COLOURS = { controllers: 0x2b7bb9, firTags: 0x3ba55c } as const;
export const TYPE_PRIORITY: Record<string, number> = { FMP: 0, CTR: 1, FSS: 1, APP: 2, DEP: 2, TWR: 3, GND: 3, DEL: 3 };

export const MELBOURNE = "Melbourne FIR (YMMM)";
export const BRISBANE = "Brisbane FIR (YBBB)";
export const UNKNOWN_FIR = "Outside the dataset's sectors";
const FIR_ORDER = [MELBOURNE, BRISBANE];
const FOREIGN_FIRS: Array<[RegExp, string]> = [
  [/^WAAF/i, "Ujung Pandang FIR (WAAF)"],
  [/^WIIF/i, "Jakarta FIR (WIIF)"],
  [/^ZAK/i, "Oakland Oceanic FIR (KZAK)"]
];

export type SectorRow = {
  name: string;
  callsign: string | null;
  type: string | null;
  frequency: string | null;
  responsible_sectors: string[] | null;
};

export type ControllerStat = {
  callsign: string;
  sector: string | null;
  type: string | null;
  frequency: string | null;
  onOzServer: boolean;
  extending: string[];
  tags: string[];
};

export type FirStat = {
  fir: string;
  tracked: Array<{ callsign: string; by: string }>;
  untracked: string[];
};

export type Embed = {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
};

// Which FIR a sector belongs to. An enroute sector's callsign says it (ML- Melbourne, BN- Brisbane);
// anything else - a TMA, a tower - takes the FIR of the enroute group covering it, found by walking
// responsible_sectors upwards. The foreign FIRs in the dataset are named by their callsigns.
export function firResolver(sectors: SectorRow[]): (sector: string | null | undefined) => string {
  const byName = new Map(sectors.map(sector => [sector.name, sector] as const));
  const parents = parentMap(sectors);

  const firOfCallsign = (callsign: string | null | undefined): string | null => {
    if (!callsign) return null;
    const upper = callsign.toUpperCase();
    if (upper.startsWith("ML-")) return MELBOURNE;
    if (upper.startsWith("BN-")) return BRISBANE;
    for (const [pattern, label] of FOREIGN_FIRS) {
      if (pattern.test(upper)) return label;
    }
    return null;
  };

  const cache = new Map<string, string>();
  return sector => {
    if (!sector) return UNKNOWN_FIR;
    const cached = cache.get(sector);
    if (cached) return cached;

    // Breadth first, so the nearest enroute group decides.
    let fir: string | null = null;
    const seen = new Set<string>([sector]);
    let frontier = [sector];
    while (frontier.length > 0 && fir === null) {
      const next: string[] = [];
      for (const name of frontier) {
        fir = firOfCallsign(byName.get(name)?.callsign);
        if (fir !== null) break;
        for (const parent of parents.get(name) ?? []) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          next.push(parent);
        }
      }
      frontier = next;
    }

    const result = fir ?? UNKNOWN_FIR;
    cache.set(sector, result);
    return result;
  };
}

// Every sector `name` is covered by, all the way up.
export function ancestorsOf(name: string, parents: Map<string, string[]>): Set<string> {
  const found = new Set<string>();
  let frontier = parents.get(name) ?? [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parent of frontier) {
      if (found.has(parent)) continue;
      found.add(parent);
      next.push(...(parents.get(parent) ?? []));
    }
    frontier = next;
  }
  return found;
}

// Each sector's covering sectors, from responsible_sectors (a group lists itself, which is skipped).
export function parentMap(sectors: SectorRow[]): Map<string, string[]> {
  const parents = new Map<string, string[]>();
  for (const sector of sectors) {
    for (const child of sector.responsible_sectors ?? []) {
      if (child === sector.name) continue;
      const list = parents.get(child) ?? [];
      list.push(sector.name);
      parents.set(child, list);
    }
  }
  return parents;
}

// Melbourne, then Brisbane, then the foreign FIRs by name, then flights in no known sector.
export function sortFirs(firs: FirStat[]): FirStat[] {
  const rank = (name: string) => {
    const index = FIR_ORDER.indexOf(name);
    if (index >= 0) return index;
    return name === UNKNOWN_FIR ? 99 : 50;
  };
  return [...firs].sort((a, b) => rank(a.fir) - rank(b.fir) || a.fir.localeCompare(b.fir));
}

// Joins lines until the next would pass `limit`, then says how many were left out.
function fit(lines: string[], limit: number, separator = "\n"): string {
  let text = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const candidate = text ? text + separator + line : line;
    const remaining = lines.length - index - 1;
    const more = remaining > 0 ? `${separator}... and ${remaining} more` : "";
    if (candidate.length + more.length > limit) {
      const left = lines.length - index;
      return text + (text ? separator : "") + `... and ${left} more`;
    }
    text = candidate;
  }
  return text;
}

export function controllersEmbed(controllers: ControllerStat[], now: Date): Embed {
  const onOzServer = controllers.filter(controller => controller.onOzServer).length;
  const tagCount = controllers.reduce((total, controller) => total + controller.tags.length, 0);
  const blocks = controllers.map(controller => {
    const where = [controller.sector, controller.frequency].filter(Boolean).join(" · ");
    const badge = controller.onOzServer ? "🟢 OzServer" : "⚪ No plugin";
    const lines = [`**${controller.callsign}**${where ? ` — ${where}` : ""} · ${badge}`];
    if (controller.extending.length > 0) lines.push(`Extending: ${controller.extending.join(", ")}`);
    lines.push(controller.tags.length > 0
      ? `Tags (${controller.tags.length}): ${fit(controller.tags, 600, ", ")}`
      : "No tags");
    return lines.join("\n");
  });

  return {
    title: "🎧 Online Controllers",
    description: blocks.length > 0 ? fit(blocks, DESCRIPTION_LIMIT, "\n\n") : "No Australian controllers are online.",
    color: COLOURS.controllers,
    footer: { text: `${controllers.length} online · ${onOzServer} on OzServer · ${tagCount} tags tracked · updates every minute` },
    timestamp: now.toISOString()
  };
}

export function firTagsEmbed(firs: FirStat[], now: Date): Embed {
  const total = firs.reduce((sum, entry) => sum + entry.tracked.length + entry.untracked.length, 0);
  const fields = firs.slice(0, MAX_FIELDS).map(entry => {
    const byController = new Map<string, string[]>();
    for (const tag of entry.tracked) {
      const list = byController.get(tag.by) ?? [];
      list.push(tag.callsign);
      byController.set(tag.by, list);
    }
    const lines: string[] = [];
    if (entry.tracked.length > 0) {
      lines.push(`**Tracked (${entry.tracked.length})**`);
      for (const [controller, tags] of [...byController].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`${controller}: ${tags.join(", ")}`);
      }
    }
    if (entry.untracked.length > 0) {
      lines.push(`**Untracked (${entry.untracked.length})**`);
      lines.push(entry.untracked.join(", "));
    }
    const count = entry.tracked.length + entry.untracked.length;
    return {
      name: `${entry.fir} — ${count} aircraft`,
      value: fit(lines, FIELD_LIMIT)
    };
  });

  return {
    title: "🛫 Tags by FIR",
    description: total > 0
      ? `Flights OzServer clients reported in the last ${RECENT_MINUTES} minutes.`
      : "No flights are being reported by OzServer clients.",
    color: COLOURS.firTags,
    fields,
    footer: { text: `${total} aircraft · updates every minute` },
    timestamp: now.toISOString()
  };
}

