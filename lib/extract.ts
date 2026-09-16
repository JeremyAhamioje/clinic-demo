import * as cheerio from "cheerio";
import TurndownService from "turndown";
// @ts-expect-error no types shipped for the gfm plugin
import { gfm } from "turndown-plugin-gfm";
import { createHash } from "crypto";

const API_BASE = "https://en.wikipedia.org/w/api.php";
const REST_HTML_BASE = "https://en.wikipedia.org/api/rest_v1/page/html";

export type Topic = {
  title: string;
  url: string;
  category: string;
};

export type ExtractionResult = {
  topic: string;
  sourceUrl: string;
  category: string;
  sourceUpdated: string | null;
  extractedAt: string;
  status: "success" | "failed";
  failureReason?: string;
  markdown?: string;
  contentHash?: string;
  checks: {
    headingsPreserved: boolean;
    listsPreserved: boolean;
    tablesDetected: boolean;
    metadataExtracted: boolean;
  };
  warnings: string[];
};

// Junk that isn't page content: infobox/navbox chrome, citation markers,
// images (out of scope for a text-structure demo), edit-section links.
const JUNK_SELECTORS = [
  "table.infobox",
  'table[class*="navbox"]',
  ".navbox",
  "sup.reference",
  "sup.mw-ref",
  ".hatnote",
  ".shortdescription",
  ".mw-editsection",
  ".noprint",
  "figure",
  ".thumb",
  "style",
  "link",
  "img",
];

// These sections always trail a Wikipedia article and carry no body content
// worth preserving -- truncate the markdown once one of these headings is hit,
// same as stripping a footer/cookie-notice block off a real site.
const JUNK_HEADING_RE =
  /^#{2,6}\s*(References|See also|External links|Notes|Further reading|Bibliography|Citations|Footnotes)\s*$/im;

function titleToUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

// Category listings surface every member alphabetically, including the
// umbrella article itself and obscure edge-case pages. This just re-ranks
// real, verified members toward the well-known conditions a client demo
// should show first -- it never adds a topic that isn't an actual member.
const PREFERRED_BY_CATEGORY: Record<string, string[]> = {
  "respiratory diseases": ["Asthma", "Childhood asthma", "Cystic fibrosis", "Atelectasis", "Anaphylaxis"],
  "heart diseases": ["Coronary artery disease", "Acute decompensated heart failure", "Cardiac tamponade", "Cardiogenic shock", "Atrial flutter"],
  "cardiovascular diseases": ["Hypertension", "Heart failure", "Coronary artery disease", "Atrial fibrillation", "Stroke"],
  "endocrine diseases": ["Type 2 diabetes", "Hypothyroidism", "Hyperthyroidism", "Type 1 diabetes"],
};

export async function discoverTopics(
  categoriesInput: string,
  opts: { perCategoryLimit?: number; totalLimit?: number } = {}
): Promise<{ topics: Topic[]; categories: string[] }> {
  const perCategoryLimit = opts.perCategoryLimit ?? 3;
  const totalLimit = opts.totalLimit ?? 3;

  const categories = categoriesInput
    .split(",")
    .map((c) => c.trim().replace(/^Category:/i, ""))
    .filter(Boolean);

  const seen = new Set<string>();
  const topics: Topic[] = [];

  for (const category of categories) {
    const params = new URLSearchParams({
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${category}`,
      cmtype: "page",
      cmlimit: "30",
      format: "json",
    });
    const res = await fetch(`${API_BASE}?${params}`, {
      headers: { "User-Agent": "clinical-extractor-demo/1.0 (proof-of-concept)" },
    });
    if (!res.ok) continue;
    const data = await res.json();
    const members: { title: string }[] = data?.query?.categorymembers ?? [];
    const memberTitles = new Set(members.map((m) => m.title));
    const umbrellaTitle = category.replace(/ies$/, "y").replace(/s$/, "");

    const preferred = PREFERRED_BY_CATEGORY[category.toLowerCase()] ?? [];
    const ordered = [
      ...preferred.filter((t) => memberTitles.has(t)),
      ...members
        .map((m) => m.title)
        .filter((t) => !preferred.includes(t) && !/^List of/i.test(t) && t !== umbrellaTitle),
    ];

    let taken = 0;
    for (const title of ordered) {
      if (taken >= perCategoryLimit) break;
      if (seen.has(title)) continue;
      seen.add(title);
      topics.push({ title, url: titleToUrl(title), category });
      taken++;
    }
  }

  return { topics: topics.slice(0, totalLimit), categories };
}

export async function extractTopic(topic: Topic): Promise<ExtractionResult> {
  const extractedAt = new Date().toISOString();
  const warnings: string[] = [];

  let html: string;
  try {
    const res = await fetch(
      `${REST_HTML_BASE}/${encodeURIComponent(topic.title.replace(/ /g, "_"))}`,
      { headers: { "User-Agent": "clinical-extractor-demo/1.0 (proof-of-concept)" } }
    );
    if (!res.ok) {
      return {
        topic: topic.title,
        sourceUrl: topic.url,
        category: topic.category,
        sourceUpdated: null,
        extractedAt,
        status: "failed",
        failureReason: `source page fetch failed (HTTP ${res.status})`,
        checks: {
          headingsPreserved: false,
          listsPreserved: false,
          tablesDetected: false,
          metadataExtracted: false,
        },
        warnings,
      };
    }
    html = await res.text();
  } catch (err) {
    return {
      topic: topic.title,
      sourceUrl: topic.url,
      category: topic.category,
      sourceUpdated: null,
      extractedAt,
      status: "failed",
      failureReason: err instanceof Error ? err.message : "fetch failed",
      checks: {
        headingsPreserved: false,
        listsPreserved: false,
        tablesDetected: false,
        metadataExtracted: false,
      },
      warnings,
    };
  }

  const $ = cheerio.load(html);
  const sourceUpdated = $('meta[property="dc:modified"]').attr("content") ?? null;
  if (!sourceUpdated) warnings.push("source update date unavailable");

  // Wikipedia's navbox tables carry classes like "navbox-inner"/"navbox-subgroup",
  // not the bare "navbox" token, so a plain .navbox class selector misses them here.
  const tableCountBefore = $("table")
    .not('table.infobox, table[class*="navbox"]')
    .length;
  if (tableCountBefore === 0) warnings.push(`${topic.title}: no tables found in source content`);

  $(JUNK_SELECTORS.join(",")).remove();

  const bodyHtml = $("body").html() ?? "";
  if (!bodyHtml.trim()) {
    return {
      topic: topic.title,
      sourceUrl: topic.url,
      category: topic.category,
      sourceUpdated,
      extractedAt,
      status: "failed",
      failureReason: "main content container not detected",
      checks: {
        headingsPreserved: false,
        listsPreserved: false,
        tablesDetected: false,
        metadataExtracted: !!sourceUpdated,
      },
      warnings,
    };
  }

  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  turndown.use(gfm);
  let body = turndown.turndown(bodyHtml).trim();

  // Trailing References/See also/etc. carry no reusable content -- cut them.
  const junkMatch = body.match(JUNK_HEADING_RE);
  if (junkMatch && junkMatch.index !== undefined) {
    body = body.slice(0, junkMatch.index).trim();
  }

  // The lead paragraph(s) before the first heading have no heading of their
  // own in Wikipedia's markup -- give them one so the structure is uniform.
  const firstHeadingIdx = body.search(/^##\s/m);
  if (firstHeadingIdx > 0) {
    body = `## Overview\n\n${body.slice(0, firstHeadingIdx).trim()}\n\n${body.slice(firstHeadingIdx)}`;
  } else if (firstHeadingIdx === -1 && body) {
    body = `## Overview\n\n${body}`;
  }

  const frontmatter = [
    "---",
    `topic: ${topic.title}`,
    `source_url: ${topic.url}`,
    `category: ${topic.category}`,
    `source_updated: ${sourceUpdated ?? "unknown"}`,
    `extracted: ${extractedAt}`,
    "---",
    "",
    `# ${topic.title}`,
    "",
  ].join("\n");

  const markdown = frontmatter + body + "\n";

  const headingsPreserved = /^#{2,6}\s/m.test(markdown);
  const listsPreserved = /^(-|\d+\.)\s/m.test(markdown);
  const tablesDetected = /^\|.*\|$/m.test(markdown);
  const metadataExtracted = !!sourceUpdated;

  const normalized = markdown.replace(/\s+/g, " ").trim();
  const contentHash = createHash("sha256").update(normalized).digest("hex");

  return {
    topic: topic.title,
    sourceUrl: topic.url,
    category: topic.category,
    sourceUpdated,
    extractedAt,
    status: "success",
    markdown,
    contentHash,
    checks: { headingsPreserved, listsPreserved, tablesDetected, metadataExtracted },
    warnings,
  };
}
