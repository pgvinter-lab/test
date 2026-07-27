import type {
  CapabilityKind,
  CapabilityPricing,
} from "./types.js";
import { MCPSERVERS_ORIGIN } from "./fetch-policy.js";

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_LOCATIONS = 25_000;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const AUTHOR = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface SitemapReference {
  url: string;
  kind: "server" | "skill";
}

export interface SitemapEntry {
  identity: string;
  kind: "server" | "skill";
  slug: string;
  author: string | null;
  url: string;
  lastmod: string | null;
}

export interface ParsedCapability {
  identity: string;
  slug: string;
  author: string | null;
  source_url: string;
  name: string;
  kind: CapabilityKind;
  description: string | null;
  category: string | null;
  official: 0 | 1;
  stars: number | null;
  pricing: CapabilityPricing;
  install_command: string | null;
  sponsor: boolean;
  curated: boolean;
}

export interface ParseResult<T> {
  value: T;
  gaps: string[];
}

export interface ParsedDetail {
  description: string | null;
  category: string | null;
  pricing: CapabilityPricing;
  install_command: string | null;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertDocument(value: string): void {
  if (typeof value !== "string" || bytes(value) > MAX_DOCUMENT_BYTES) {
    throw new Error("mcpservers_document_invalid");
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (matched, hex: string) => {
      const point = Number.parseInt(hex, 16);
      return point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : matched;
    })
    .replace(/&#(\d+);/g, (matched, decimal: string) => {
      const point = Number.parseInt(decimal, 10);
      return point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : matched;
    })
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'");
}

function secretLike(value: string): boolean {
  return /\bBearer\s+\S{8,}/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i.test(value)
    || /\b(?:token|secret|password|api[_-]?key|authorization|cookie|credential)\s*[:=]\s*\S{6,}/i.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function sanitizedText(
  raw: string,
  maximum = MAX_TEXT_BYTES,
): string | null {
  const value = decodeEntities(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length === 0 || bytes(value) > maximum || secretLike(value)) {
    return null;
  }
  return value;
}

function canonicalPublicUrl(raw: string): URL | null {
  try {
    const url = new URL(decodeEntities(raw.trim()), MCPSERVERS_ORIGIN);
    if (
      url.origin !== MCPSERVERS_ORIGIN
      || url.username !== ""
      || url.password !== ""
      || url.port !== ""
      || url.search !== ""
      || url.hash !== ""
    ) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
  } catch {
    return null;
  }
}

export function parseCapabilityUrl(raw: string): SitemapEntry | null {
  const url = canonicalPublicUrl(raw);
  if (!url) return null;

  const server = url.pathname.match(/^\/servers\/([^/]+)$/);
  if (server) {
    const slug = server[1].toLowerCase();
    if (!SLUG.test(slug)) return null;
    const canonical = `${MCPSERVERS_ORIGIN}/servers/${slug}`;
    return {
      identity: `server:${canonical}`,
      kind: "server",
      slug,
      author: null,
      url: canonical,
      lastmod: null,
    };
  }

  const simpleSkill = url.pathname.match(/^\/skills\/([^/]+)$/);
  if (simpleSkill) {
    const slug = simpleSkill[1].toLowerCase();
    if (!SLUG.test(slug)) return null;
    const canonical = `${MCPSERVERS_ORIGIN}/skills/${slug}`;
    return {
      identity: `skill:${canonical}`,
      kind: "skill",
      slug,
      author: null,
      url: canonical,
      lastmod: null,
    };
  }

  const authoredSkill = url.pathname.match(
    /^\/agent-skills\/([^/]+)\/([^/]+)$/,
  );
  if (authoredSkill) {
    const author = authoredSkill[1].toLowerCase();
    const slug = authoredSkill[2].toLowerCase();
    if (!AUTHOR.test(author) || !SLUG.test(slug)) return null;
    const canonical =
      `${MCPSERVERS_ORIGIN}/agent-skills/${author}/${slug}`;
    return {
      identity: `skill:${canonical}`,
      kind: "skill",
      slug,
      author,
      url: canonical,
      lastmod: null,
    };
  }

  return null;
}

function locations(document: string): string[] {
  const output: string[] = [];
  const expression = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  for (const match of document.matchAll(expression)) {
    if (output.length >= MAX_LOCATIONS) {
      throw new Error("mcpservers_locations_too_many");
    }
    output.push(decodeEntities(match[1].trim()));
  }
  return output;
}

export function parseRootSitemaps(
  xml: string,
): ParseResult<SitemapReference[]> {
  assertDocument(xml);
  const gaps: string[] = [];
  const references = new Map<string, SitemapReference>();
  for (const raw of locations(xml)) {
    const url = canonicalPublicUrl(raw);
    if (!url) {
      gaps.push("root_sitemap_location_invalid");
      continue;
    }
    let kind: "server" | "skill" | null = null;
    if (
      /^\/servers\/\d+\.xml$/.test(url.pathname)
      || url.pathname === "/server-sitemap.xml"
    ) {
      kind = "server";
    } else if (
      url.pathname === "/skills.xml"
      || url.pathname === "/skills-sitemap.xml"
    ) {
      kind = "skill";
    }
    if (!kind) {
      gaps.push("root_sitemap_path_unsupported");
      continue;
    }
    references.set(url.href, { url: url.href, kind });
  }
  if (references.size === 0) gaps.push("root_sitemap_empty");
  return {
    value: [...references.values()].sort((left, right) =>
      left.url.localeCompare(right.url)),
    gaps,
  };
}

function normalizedLastmod(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = decodeEntities(raw.trim());
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return value.length === 10
    ? `${value}T00:00:00.000Z`
    : new Date(Date.parse(value)).toISOString();
}

export function parseSitemapEntries(
  xml: string,
  expectedKind: "server" | "skill",
): ParseResult<SitemapEntry[]> {
  assertDocument(xml);
  const gaps: string[] = [];
  const entries = new Map<string, SitemapEntry>();
  const blocks = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)];
  if (blocks.length > MAX_LOCATIONS) {
    throw new Error("mcpservers_locations_too_many");
  }
  for (const block of blocks) {
    const loc = block[1].match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i)?.[1];
    if (!loc) {
      gaps.push("sitemap_entry_location_missing");
      continue;
    }
    const entry = parseCapabilityUrl(loc);
    if (!entry || entry.kind !== expectedKind) {
      gaps.push("sitemap_entry_location_invalid");
      continue;
    }
    const rawLastmod =
      block[1].match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i)?.[1];
    const lastmod = normalizedLastmod(rawLastmod);
    if (rawLastmod && !lastmod) gaps.push("sitemap_lastmod_invalid");
    const candidate = { ...entry, lastmod };
    const previous = entries.get(entry.identity);
    if (previous && previous.lastmod !== candidate.lastmod) {
      gaps.push("sitemap_entry_duplicate_conflict");
      continue;
    }
    entries.set(entry.identity, candidate);
  }
  if (blocks.length === 0) gaps.push("sitemap_entries_empty");
  return {
    value: [...entries.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity)),
    gaps,
  };
}

function cardBlocks(html: string): string[] {
  const starts = [...html.matchAll(
    /<(?:article|div)\b[^>]*class=(["'])[^"']*\bcard\b[^"']*\1[^>]*>/gi,
  )];
  return starts.map((start, index) => {
    const from = start.index ?? 0;
    const to = starts[index + 1]?.index ?? html.length;
    return html.slice(from, to);
  });
}

function classContent(block: string, className: string): string | undefined {
  const expression = new RegExp(
    `<[^>]*class=(["'])[^"']*\\b${className}\\b[^"']*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`,
    "i",
  );
  return block.match(expression)?.[2];
}

function hasClass(block: string, className: string): boolean {
  const expression = new RegExp(
    `class=(["'])[^"']*\\b${className}\\b[^"']*\\1`,
    "i",
  );
  return expression.test(block);
}

function optionalText(
  block: string,
  className: string,
  gaps: string[],
): string | null {
  const raw = classContent(block, className);
  if (raw === undefined) return null;
  const value = sanitizedText(raw);
  if (value === null) gaps.push(`listing_${className}_invalid`);
  return value;
}

export function parseListings(
  html: string,
): ParseResult<ParsedCapability[]> {
  assertDocument(html);
  const gaps: string[] = [];
  const items = new Map<string, ParsedCapability>();
  const blocks = cardBlocks(html);
  for (const block of blocks) {
    const href = block.match(
      /<a\b[^>]*href=(["'])([^"']+)\1[^>]*>/i,
    )?.[2];
    const entry = href ? parseCapabilityUrl(href) : null;
    if (!entry) {
      gaps.push("listing_identity_invalid");
      continue;
    }
    const rawName = classContent(block, "title");
    const name = rawName ? sanitizedText(rawName, 512) : null;
    if (!name) {
      gaps.push("listing_name_invalid");
      continue;
    }
    const description = optionalText(block, "blurb", gaps);
    const category = optionalText(block, "category", gaps);
    const pricingEvidence = optionalText(block, "pricing", gaps);
    let pricing: CapabilityPricing = "unknown";
    if (pricingEvidence) {
      const normalized = pricingEvidence.toLowerCase();
      if (normalized === "free") pricing = "free";
      else if (
        normalized === "paid"
        || normalized === "pro"
        || normalized === "premium"
        || normalized === "subscription"
      ) {
        pricing = "paid";
      } else if (normalized !== "unknown") {
        gaps.push("listing_pricing_unrecognized");
      }
    }

    let stars: number | null = null;
    const starsEvidence = optionalText(block, "stars", gaps);
    if (starsEvidence) {
      if (/^\d{1,3}(?:,\d{3})*$|^\d+$/.test(starsEvidence)) {
        stars = Number(starsEvidence.replace(/,/g, ""));
      } else {
        gaps.push("listing_stars_invalid");
      }
    }

    let installCommand = optionalText(block, "install", gaps);
    if (
      installCommand
      && (
        bytes(installCommand) > MAX_COMMAND_BYTES
        || /[\r\n\0]/.test(installCommand)
        || secretLike(installCommand)
      )
    ) {
      gaps.push("listing_install_command_invalid");
      installCommand = null;
    }

    const item: ParsedCapability = {
      identity: entry.identity,
      slug: entry.slug,
      author: entry.author,
      source_url: entry.url,
      name,
      kind: entry.kind,
      description,
      category,
      official: hasClass(block, "official") ? 1 : 0,
      curated: hasClass(block, "curated"),
      sponsor: hasClass(block, "sponsor")
        || /\bdata-sponsored=(["'])true\1/i.test(block),
      stars,
      pricing,
      install_command: installCommand,
    };
    const previous = items.get(item.identity);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
      gaps.push("listing_duplicate_conflict");
      continue;
    }
    items.set(item.identity, item);
  }
  if (blocks.length === 0) gaps.push("listing_cards_empty");
  return {
    value: [...items.values()].sort((left, right) =>
      left.identity.localeCompare(right.identity)),
    gaps,
  };
}

export function parseSearchTotal(html: string): number | null {
  assertDocument(html);
  const match = html.match(
    /\b(?:found\s+)?(\d{1,3}(?:,\d{3})*|\d+)\s+(?:results|servers|skills)\b/i,
  );
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseDetail(html: string): ParseResult<ParsedDetail | null> {
  assertDocument(html);
  const gaps: string[] = [];
  const description = optionalText(html, "blurb", gaps);
  const category = optionalText(html, "category", gaps);
  const pricingEvidence = optionalText(html, "pricing", gaps);
  let pricing: CapabilityPricing = "unknown";
  if (pricingEvidence?.toLowerCase() === "free") pricing = "free";
  else if (
    pricingEvidence
    && ["paid", "pro", "premium", "subscription"].includes(
      pricingEvidence.toLowerCase(),
    )
  ) {
    pricing = "paid";
  } else if (
    pricingEvidence
    && pricingEvidence.toLowerCase() !== "unknown"
  ) {
    gaps.push("detail_pricing_unrecognized");
  }
  let installCommand = optionalText(html, "install", gaps);
  if (
    installCommand
    && (
      bytes(installCommand) > MAX_COMMAND_BYTES
      || /[\r\n\0]/.test(installCommand)
      || secretLike(installCommand)
    )
  ) {
    gaps.push("detail_install_command_invalid");
    installCommand = null;
  }
  if (!description && !category && !pricingEvidence && !installCommand) {
    gaps.push("detail_fields_empty");
    return { value: null, gaps };
  }
  return {
    value: {
      description,
      category,
      pricing,
      install_command: installCommand,
    },
    gaps,
  };
}

// Compatibility helpers retained for the Package 05 public module surface.
export function parseSitemapRoot(xml: string): string[] {
  return parseRootSitemaps(xml).value.map((entry) => entry.url);
}

export function parseSitemapUrls(
  xml: string,
  expectedKind: "server" | "skill",
): string[] {
  return parseSitemapEntries(xml, expectedKind).value.map((entry) => entry.url);
}
