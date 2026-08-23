import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RankedItem } from "../lib/types.ts";
import { formatUsd } from "../lib/money.ts";

const STYLES_PATH = join(dirname(fileURLToPath(import.meta.url)), "styles.css");

export type NewsletterTopicSection = {
  name: string;
  slug: string;
  items: RankedItem[];
};

export type RenderNewsletterOptions = {
  topics: string[];
  items: RankedItem[];
  generatedAt?: Date;
  title?: string;
  stylesCss?: string;
  cost?: number;
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Keep only http(s) links in href attributes. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function slugifyTopic(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "topic";
}

export function groupItemsByTopicOrder(
  topics: string[],
  items: RankedItem[],
): NewsletterTopicSection[] {
  const byTopic = new Map<string, RankedItem[]>();
  for (const item of items) {
    const list = byTopic.get(item.topic) ?? [];
    list.push(item);
    byTopic.set(item.topic, list);
  }

  const usedSlugs = new Map<string, number>();
  const sections: NewsletterTopicSection[] = [];

  for (const name of topics) {
    const base = slugifyTopic(name);
    const count = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, count + 1);
    const slug = count === 0 ? base : `${base}-${count + 1}`;
    sections.push({
      name,
      slug,
      items: byTopic.get(name) ?? [],
    });
  }

  return sections;
}

function loadStylesCss(): string {
  return readFileSync(STYLES_PATH, "utf8");
}

function storySummary(item: RankedItem): string {
  const text = item.summary?.trim();
  if (text) return text;
  return "No summary available.";
}

function renderStory(item: RankedItem, index: number): string {
  const href = safeHref(item.link);
  const title = escapeHtml(item.title);
  const summary = escapeHtml(storySummary(item));
  const source = escapeHtml(item.source);
  const rank = String(index + 1).padStart(2, "0");
  const titleHtml = href
    ? `<a class="story-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span class="story-title">${title}</span>`;

  return `<article class="story-card">
  <span class="story-rank">${rank}</span>
  <div class="min-w-0 flex-1">
    ${titleHtml}
    <p class="story-summary">${summary}</p>
    <div class="story-meta">
      <span class="source-pill">${source}</span>
      ${
        href
          ? `<a class="story-open" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open article</a>`
          : ""
      }
    </div>
  </div>
</article>`;
}

function renderTabs(sections: NewsletterTopicSection[]): string {
  return sections
    .map((section, index) => {
      const selected = index === 0 ? "true" : "false";
      return `<a
        class="tab-link"
        href="#${escapeHtml(section.slug)}"
        role="tab"
        id="tab-${escapeHtml(section.slug)}"
        aria-controls="${escapeHtml(section.slug)}"
        aria-selected="${selected}"
        data-tab="${escapeHtml(section.slug)}"
      >${escapeHtml(section.name)}<span class="tab-count">${section.items.length}</span></a>`;
    })
    .join("\n");
}

function renderPanels(sections: NewsletterTopicSection[]): string {
  return sections
    .map((section, index) => {
      const active = index === 0 ? " is-active" : "";
      const hidden = index === 0 ? "false" : "true";
      const body =
        section.items.length === 0
          ? `<div class="empty-state">No stories for this topic in this edition.</div>`
          : `<div class="story-list">${section.items.map(renderStory).join("\n")}</div>`;

      return `<section
  class="topic-panel${active}"
  id="${escapeHtml(section.slug)}"
  role="tabpanel"
  aria-labelledby="tab-${escapeHtml(section.slug)}"
  data-panel="${escapeHtml(section.slug)}"
  aria-hidden="${hidden}"
>${body}</section>`;
    })
    .join("\n");
}

const TAB_SCRIPT = `(() => {
  const tabs = Array.from(document.querySelectorAll('[data-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-panel]'));
  if (!tabs.length || !panels.length) return;

  function activate(slug) {
    for (const tab of tabs) {
      const on = tab.getAttribute('data-tab') === slug;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const panel of panels) {
      const on = panel.getAttribute('data-panel') === slug;
      panel.classList.toggle('is-active', on);
      panel.setAttribute('aria-hidden', on ? 'false' : 'true');
    }
    if (location.hash.slice(1) !== slug) {
      history.replaceState(null, '', '#' + slug);
    }
  }

  function fromHash() {
    const slug = location.hash.slice(1);
    const match = tabs.find((tab) => tab.getAttribute('data-tab') === slug);
    activate(match ? slug : tabs[0].getAttribute('data-tab'));
  }

  for (const tab of tabs) {
    tab.addEventListener('click', (event) => {
      event.preventDefault();
      activate(tab.getAttribute('data-tab'));
    });
  }

  window.addEventListener('hashchange', fromHash);
  fromHash();
})();`;

export function renderNewsletterHtml(opts: RenderNewsletterOptions): string {
  const generatedAt = opts.generatedAt ?? new Date();
  const title = opts.title ?? "News newsletter";
  const sections = groupItemsByTopicOrder(opts.topics, opts.items);
  const styles = opts.stylesCss ?? loadStylesCss();
  const dateLabel = generatedAt.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const totalStories = opts.items.length;
  const costLabel = `Cost ${formatUsd(opts.cost ?? 0)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="app-shell mx-auto flex w-full max-w-5xl flex-col gap-2.5 px-3 py-2.5 md:gap-3 md:px-6 md:py-4 lg:max-w-6xl lg:px-8">
    <header class="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-1 px-1">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-1">
        <h1 class="flex items-center gap-2 text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-sky-400 md:text-xs"><span class="inline-block size-1.5 rounded-full bg-sky-400"></span>Newsletter</h1>
        <p class="text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-sky-400 md:text-xs">${escapeHtml(costLabel)}</p>
      </div>
      <p class="shrink-0 text-[0.65rem] font-semibold uppercase tracking-[0.22em] text-sky-400 md:text-xs">${escapeHtml(dateLabel)} · ${totalStories} stor${totalStories === 1 ? "y" : "ies"}</p>
    </header>

    <nav class="tab-bar" role="tablist" aria-label="Topics">
${renderTabs(sections)}
    </nav>

${renderPanels(sections)}
  </div>
  <script>${TAB_SCRIPT}</script>
</body>
</html>
`;
}

export function newsletterFilename(generatedAt = new Date()): string {
  const y = generatedAt.getFullYear();
  const m = String(generatedAt.getMonth() + 1).padStart(2, "0");
  const d = String(generatedAt.getDate()).padStart(2, "0");
  return `newsletter-${y}-${m}-${d}.html`;
}
