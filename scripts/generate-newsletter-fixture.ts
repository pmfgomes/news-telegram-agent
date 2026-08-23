import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RankedItem } from "../src/lib/types.ts";
import { renderNewsletterHtml } from "../src/newsletter/index.ts";

function item(
  overrides: Partial<RankedItem> & Pick<RankedItem, "id" | "title" | "topic">,
): RankedItem {
  return {
    link: "https://example.com/story",
    source: "Example",
    publishedAt: new Date("2026-08-20T10:00:00Z"),
    summary: "A short factual summary of the story.",
    score: 0.9,
    threadId: 1,
    relatedItems: [],
    ...overrides,
  };
}

const topics = [
  "Technology",
  "AI",
  "Gaming",
  "World news",
  "World economy",
  "Portugal",
  "Portugal economy",
  "Algarve",
] as const;

const storyBlueprints: Record<
  (typeof topics)[number],
  { source: string; titles: string[] }
> = {
  Portugal: {
    source: "RTP",
    titles: [
      "Cabinet debates housing package in Lisbon",
      "Coastal towns prepare for summer heat alerts",
      "Parliament advances labour reform vote",
      "Lisbon metro expands late-night service",
      "National museums report record August visits",
      "Wildfire crews reinforce Alentejo containment lines",
      "Schools reopen with new digital attendance rules",
      "Energy regulator reviews household tariff plan",
      "Porto council funds riverside flood barriers",
      "Farmers protest delayed EU subsidy payments",
    ],
  },
  AI: {
    source: "The Verge",
    titles: [
      "Lab ships multimodal model with lower inference cost",
      "Regulators draft disclosure rules for foundation models",
      "Open-source team releases long-context checkpoint",
      "Cloud vendor cuts GPU reservation wait times",
      "Hospital pilot uses triage assistant in ER intake",
      "Researchers publish watermarking benchmark suite",
      "Startup raises round for on-device speech models",
      "Enterprise suite adds citation-backed chat mode",
      "Chipmaker details AI accelerator packaging update",
      "Safety board urges evals before public releases",
    ],
  },
  Gaming: {
    source: "IGN",
    titles: [
      "Studio delays open-world sequel to early 2027",
      "Competitive shooter season adds ranked map pool",
      "Indie platformer hits one million wishlists",
      "Publisher confirms cross-save for remaster trilogy",
      "Esports league expands to South America split",
      "RPG expansion drops new companion questline",
      "Console patch fixes frame pacing in campaign",
      "Dev diary outlines survival crafting roadmap",
      "Mobile fighter crossover event goes live",
      "Critics roundup: weekend launch scores land",
    ],
  },
  Technology: {
    source: "BBC Technology",
    titles: [
      "Chipmaker outlines next-gen foundry roadmap",
      "Browser vendor hardens default cookie controls",
      "Smartphone maker ships satellite messaging globally",
      "Cloud outage postmortem cites config cascade",
      "Security firm patches zero-day in VPN appliance",
      "EU interoperability rules hit messaging apps",
      "Laptop refresh brings brighter outdoor displays",
      "Carrier trials standalone 5G slicing for factories",
      "Storage vendor doubles consumer SSD endurance",
      "Open-source maintainers ship major TLS library",
    ],
  },
  "World news": {
    source: "BBC World",
    titles: [
      "Ceasefire talks resume after weekend attacks",
      "Summit leaders agree provisional trade framework",
      "Storm leaves coastal cities without power",
      "Election officials certify disputed recount",
      "Refugees cross border after overnight clashes",
      "Central bank holds rates amid inflation cooling",
      "Diplomats reopen consular channel after months",
      "Health agency tracks new regional outbreak",
      "Court blocks emergency surveillance decree",
      "Aid convoy reaches cut-off town after deal",
    ],
  },
  "World economy": {
    source: "CNBC",
    titles: [
      "Central banks signal coordinated rate path",
      "Global supply chains adapt to tariff shifts",
      "Oil prices steady after OPEC+ meeting",
      "IMF revises global growth outlook upward",
      "Dollar strengthens as markets eye inflation data",
      "EU unveils competitiveness fund for industry",
      "Asian markets rally on tech earnings beat",
      "Shipping costs fall as canal routes reopen",
      "Sovereign debt auctions draw strong demand",
      "Trade ministers reach digital services accord",
    ],
  },
  "Portugal economy": {
    source: "ECO",
    titles: [
      "Lisbon office rents climb to record highs",
      "Auto parts exports rise despite slowdown",
      "Government unveils corporate tax reduction plan",
      "Tourism revenue beats summer expectations",
      "Startups attract record venture funding round",
      "Unemployment falls to lowest since 2002",
      "Banks report rising mortgage demand",
      "Renewable auctions secure below-market prices",
      "Retail sales grow for third straight quarter",
      "Public debt ratio drops below 100 percent",
    ],
  },
  Algarve: {
    source: "Região Sul",
    titles: [
      "Faro airport expands winter flight schedule",
      "Albufeira approves coastal walkway extension",
      "Water reserves rise after autumn rainfall",
      "Lagos marina hosts international sailing regatta",
      "Regional hotels report record October occupancy",
      "New cycling route links eastern Algarve towns",
      "Fishing quotas bring relief to Olhão fleet",
      "Tavira restores historic market hall",
      "Golf courses invest in recycled irrigation",
      "Citrus harvest starts early in Silves orchards",
    ],
  },
};

const items: RankedItem[] = topics.flatMap((topic) => {
  const blueprint = storyBlueprints[topic];
  return blueprint.titles.map((title, index) =>
    item({
      id: `${topic.toLowerCase().replace(/\s+/g, "-")}-${index + 1}`,
      title,
      topic,
      source: blueprint.source,
      link: `https://example.com/${encodeURIComponent(topic.toLowerCase())}/${index + 1}`,
      summary: `${title.replace(/\.$/, "")}. Brief factual wrap-up for newsletter preview item ${index + 1}.`,
      score: 1 - index * 0.02,
    }),
  );
});

const html = renderNewsletterHtml({
  topics: [...topics],
  items,
  generatedAt: new Date("2026-08-20T18:30:00+01:00"),
  title: "News newsletter",
});

const outDir = join("data", "exports");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "newsletter-fixture.html");
writeFileSync(outPath, html, "utf8");
console.log(`${outPath} (${items.length} stories, ${topics.length} topics × 10)`);
