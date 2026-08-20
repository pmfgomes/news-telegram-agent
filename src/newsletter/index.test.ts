import { describe, expect, test } from "bun:test";
import type { RankedItem } from "../lib/types.ts";
import {
  groupItemsByTopicOrder,
  renderNewsletterHtml,
  safeHref,
  slugifyTopic,
} from "./index.ts";

function item(
  overrides: Partial<RankedItem> & Pick<RankedItem, "id" | "title" | "topic">,
): RankedItem {
  return {
    link: "https://example.com/story",
    source: "Example",
    publishedAt: null,
    summary: "A short factual summary.",
    score: 0.9,
    threadId: 1,
    relatedItems: [],
    ...overrides,
  };
}

const STYLES = ".story-title{color:#38bdf8}";

describe("safeHref", () => {
  test("allows http and https", () => {
    expect(safeHref("https://news.example/a")).toBe("https://news.example/a");
    expect(safeHref("http://news.example/a")).toBe("http://news.example/a");
  });

  test("rejects non-http schemes and junk", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,hi")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });
});

describe("slugifyTopic", () => {
  test("slugifies names and keeps uniqueness helpers usable", () => {
    expect(slugifyTopic("World news")).toBe("world-news");
    expect(slugifyTopic("Portugal")).toBe("portugal");
    expect(slugifyTopic("!!!")).toBe("topic");
  });
});

describe("groupItemsByTopicOrder", () => {
  test("preserves configured topic order and empty sections", () => {
    const sections = groupItemsByTopicOrder(
      ["AI", "Gaming", "Portugal"],
      [
        item({ id: "1", title: "A", topic: "Gaming" }),
        item({ id: "2", title: "B", topic: "AI" }),
      ],
    );

    expect(sections.map((s) => s.name)).toEqual(["AI", "Gaming", "Portugal"]);
    expect(sections.map((s) => s.slug)).toEqual(["ai", "gaming", "portugal"]);
    expect(sections[0]?.items).toHaveLength(1);
    expect(sections[1]?.items).toHaveLength(1);
    expect(sections[2]?.items).toHaveLength(0);
  });

  test("disambiguates duplicate topic names in slug ids", () => {
    const sections = groupItemsByTopicOrder(["AI", "AI"], []);
    expect(sections.map((s) => s.slug)).toEqual(["ai", "ai-2"]);
  });

  test("empty topics still render empty item lists", () => {
    const sections = groupItemsByTopicOrder(["Portugal"], []);
    expect(sections).toEqual([
      { name: "Portugal", slug: "portugal", items: [] },
    ]);
  });
});

describe("renderNewsletterHtml", () => {
  test("renders title, summary, link, tabs, and escapes HTML", () => {
    const html = renderNewsletterHtml({
      topics: ["AI", "Gaming"],
      items: [
        item({
          id: "1",
          title: `AI <script>alert(1)</script>`,
          topic: "AI",
          summary: `He said "hello" & left`,
          link: "https://example.com/ai",
          source: "Lab <News>",
        }),
      ],
      generatedAt: new Date("2026-08-20T12:00:00Z"),
      stylesCss: STYLES,
      title: "Test newsletter",
    });

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(STYLES);
    expect(html).toContain('href="#ai"');
    expect(html).toContain('href="#gaming"');
    expect(html).toContain('id="gaming"');
    expect(html).toContain("No stories for this topic in this edition.");
    expect(html).toContain("https://example.com/ai");
    expect(html).toContain("AI &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("He said &quot;hello&quot; &amp; left");
    expect(html).toContain("Lab &lt;News&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("data-tab=");
    expect(html).toContain("history.replaceState");
    expect(html).toContain("max-w-4xl");
    expect(html).toContain("md:text-4xl");
    expect(html).toContain("md:px-7");
  });

  test("omits unsafe article hrefs", () => {
    const html = renderNewsletterHtml({
      topics: ["AI"],
      items: [
        item({
          id: "1",
          title: "Bad link",
          topic: "AI",
          link: "javascript:alert(1)",
        }),
      ],
      stylesCss: STYLES,
    });

    expect(html).not.toContain("javascript:");
    expect(html).toContain("<span class=\"story-title\">Bad link</span>");
  });
});
