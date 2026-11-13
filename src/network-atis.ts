// Pure validation and normalisation for the ATIS a vatSys ATIS plugin publishes to this API with
// PUT /api/v1/vatsim/atis/:icao - kept free of any database import so it can be unit tested without
// a DATABASE_URL. The route itself is in routes/atis.ts.
//
// Nothing here reads VATSIM's public datafeed any more. An ATIS used to be mirrored out of that
// feed's `atis` array every 30 seconds and the sections parsed back out of its flat broadcast lines
// - so it could only ever be as fresh, and as structured, as a third party's view of the network.
// The plugin running the ATIS now publishes it directly, in the shape vatSys already holds it in:
// the section split and the change markers arrive as data instead of being re-derived from text.
import { z } from "zod";

// The sections of a vatSys ATIS, in the order the ATIS editor lays them out. MODE, OFCW_NOTIFY and
// TIME_CHECK are editor settings rather than broadcast information, so they are not among them.
export const ATIS_SECTIONS = ["APCH", "RWY", "SFC COND", "OPR INFO", "WIND", "VIS", "WX", "CLD", "TMP", "QNH", "SIGWX"] as const;
export type AtisSection = typeof ATIS_SECTIONS[number];
export type AtisContent = Record<AtisSection, string | null>;

// "atis" is an ordinary sectioned broadcast. "zulu" is the free text a closed tower leaves running
// ("CANBERRA TOWER IS CLOSED ..."), which has no sections at all - its content is that text itself,
// and nothing in it can be marked as changed.
export const ATIS_TYPES = ["atis", "zulu"] as const;
export type AtisType = typeof ATIS_TYPES[number];

// "SFC_COND" and "sfc cond" name the same section as "SFC COND": the spelling varies with where in
// vatSys the tag came from, the section does not.
const normaliseSection = (value: string): string => value.trim().toUpperCase().replace(/[\s_]+/g, " ");
const asSection = (value: string): AtisSection | null =>
  ATIS_SECTIONS.find(section => section === normaliseSection(value)) ?? null;

// Every section, always, in editor order - null for one this broadcast does not carry. A key that
// is not a section this API serves (MODE, or anything a later vatSys adds) is dropped rather than
// refused, so a plugin that sends more than this API knows about still publishes successfully.
export function atisSectionContent(input: Record<string, string | null | undefined>): AtisContent {
  const given = new Map<AtisSection, string | null>();
  for (const [key, value] of Object.entries(input)) {
    const section = asSection(key);
    if (!section) continue;
    const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    given.set(section, text || null);
  }
  return Object.fromEntries(ATIS_SECTIONS.map(section => [section, given.get(section) ?? null])) as AtisContent;
}

// The sections this letter changed - what vatSys marks with a leading + in the ATIS text. Returned
// in editor order rather than the order the plugin happened to list them, and deduplicated, so a
// consumer can compare the array directly.
export function atisChangedSections(input: readonly string[]): AtisSection[] {
  const changed = new Set(input.map(asSection));
  return ATIS_SECTIONS.filter(section => changed.has(section));
}

// A day-time group as aviation writes it - DDHHMM, e.g. 120914 for the 12th at 0914 UTC - which is
// how an ATIS time is read and spoken, rather than an ISO instant. No trailing z: every time this
// API serves is UTC and nothing here is ever local, so the marker only adds a character a consumer
// has to strip before parsing it.
export function atisTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const upperText = (max: number) => text(max).transform(value => value.toUpperCase());

// The PUT body. Deliberately forgiving about shape where it costs nothing - a letter in either
// case, a cid as a string or a number, an unknown section - and strict about the few things a
// consumer then relies on: a real airport, a single letter, a known type, and a content that
// matches that type.
export const atisUpdateSchema = z.object({
  icao: z.string().trim().regex(/^[A-Za-z]{4}$/).transform(value => value.toUpperCase()),
  callsign: upperText(32),
  atis_letter: z.string().trim().regex(/^[A-Za-z]$/).transform(value => value.toUpperCase()),
  type: z.preprocess(value => typeof value === "string" ? value.trim().toLowerCase() : value, z.enum(ATIS_TYPES)),
  // "126.250", as it is spoken and displayed. Null or absent for a broadcast with no frequency of
  // its own - kept as text rather than a number because it is only ever shown, never tuned here.
  frequency: z.string().trim().regex(/^\d{3}(\.\d{1,3})?$/).nullish(),
  // When the controller issued this letter, not when it reached us: an ATIS that sat unchanged for
  // an hour is still that letter's broadcast, and re-publishing it must not make it look newer.
  //
  // A string or a Date, and nothing else, before it is coerced: z.coerce.date() on its own turns
  // null into midnight on 1 January 1970, a bare number into that many milliseconds after it, and
  // `true` into one millisecond after it - each a valid date that would be stored and served as
  // the time this ATIS was issued.
  issued: z.union([z.string().trim().min(1), z.date()]).pipe(z.coerce.date()),
  content: z.union([z.string().trim().min(1).max(4_000), z.record(z.string().max(64), z.string().max(1_000).nullable())]),
  changed: z.array(z.string().max(64)).max(32).default([]),
  // Bounded to what the column holds (integer): anything larger passed validation and then failed
  // inside the INSERT, answered as a 500 for what is simply a bad body.
  controller: z.object({ callsign: upperText(32), cid: z.coerce.number().int().positive().max(2_147_483_647) }),
  client: z.object({ name: text(64), version: text(32) }).nullish()
}).superRefine((value, ctx) => {
  // A type/content mismatch is a plugin bug, and a silent one: stored as-is it would reach every
  // consumer as an ATIS whose content is not the shape its own type promises.
  if (value.type === "zulu" && typeof value.content !== "string") {
    ctx.addIssue({ code: "custom", path: ["content"], message: "A zulu ATIS's content is the broadcast text itself." });
  }
  if (value.type === "atis" && typeof value.content === "string") {
    ctx.addIssue({ code: "custom", path: ["content"], message: "An atis content is an object of sections." });
  }
  // Every section empty is not a quiet ATIS, it is an ATIS that was never filled in - a record of
  // nulls that a consumer cannot tell apart from a real broadcast. Refused rather than stored.
  if (value.type === "atis" && typeof value.content !== "string"
    && Object.values(atisSectionContent(value.content)).every(section => section === null)) {
    ctx.addIssue({ code: "custom", path: ["content"], message: "This ATIS carries no sections at all." });
  }
}).transform(value => ({
  icao: value.icao,
  callsign: value.callsign,
  atis_letter: value.atis_letter,
  type: value.type,
  frequency: value.frequency ?? null,
  issued: value.issued,
  content: typeof value.content === "string" ? value.content : atisSectionContent(value.content),
  changed: value.type === "zulu" ? [] : atisChangedSections(value.changed),
  controller: value.controller,
  client: value.client ?? null
}));

export type AtisUpdate = z.infer<typeof atisUpdateSchema>;
