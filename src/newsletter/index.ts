import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RankedItem } from "../lib/types.ts";

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

function renderStory(item: RankedItem): string {
  const href = safeHref(item.link);
  const title = escapeHtml(item.title);
  const summary = escapeHtml(storySummary(item));
  const source = escapeHtml(item.source);
  const titleHtml = href
    ? `<a class="story-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>`
    : `<span class="story-title">${title}</span>`;

  return `<article class="story-row">
  <div class="min-w-0 flex-1">
    ${titleHtml}
    <p class="story-summary">${summary}</p>
    <div class="story-meta">
      <span class="source-pill">${source}</span>
      ${
        href
          ? `<a class="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline md:text-sm" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open article</a>`
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
      >${escapeHtml(section.name)}</a>`;
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
          ? `<p class="px-5 py-8 text-sm text-zinc-400 md:px-7 md:py-12 md:text-base">No stories for this topic in this edition.</p>`
          : section.items.map(renderStory).join("\n");

      return `<section
  class="topic-panel${active}"
  id="${escapeHtml(section.slug)}"
  role="tabpanel"
  aria-labelledby="tab-${escapeHtml(section.slug)}"
  data-panel="${escapeHtml(section.slug)}"
  aria-hidden="${hidden}"
>
  <header class="border-b border-zinc-800 px-5 py-3 md:px-7 md:py-4">
    <h2 class="text-sm font-semibold uppercase tracking-wide text-zinc-400 md:text-base">${escapeHtml(section.name)}</h2>
    <p class="mt-0.5 text-xs text-zinc-500 md:text-sm">${section.items.length} stor${section.items.length === 1 ? "y" : "ies"}</p>
  </header>
  <div>${body}</div>
</section>`;
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body>
  <div class="mx-auto min-h-screen w-full max-w-4xl px-3 py-5 md:px-6 md:py-10 lg:max-w-5xl lg:px-8 lg:py-12">
    <header class="mb-4 md:mb-6">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 md:text-sm">Newsletter</p>
      <h1 class="mt-1 text-2xl font-bold tracking-tight text-zinc-900 md:text-4xl">${escapeHtml(title)}</h1>
      <p class="mt-1 text-sm text-zinc-500 md:mt-2 md:text-base">${escapeHtml(dateLabel)} · ${totalStories} stor${totalStories === 1 ? "y" : "ies"}</p>
    </header>

    <div class="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm md:rounded-3xl">
      <nav
        class="sticky top-0 z-10 flex flex-wrap gap-1 border-b border-zinc-200 bg-white/95 px-3 py-2 backdrop-blur md:gap-2 md:px-5 md:py-3"
        role="tablist"
        aria-label="Topics"
      >
${renderTabs(sections)}
      </nav>

      <div class="bg-zinc-950 text-zinc-100">
${renderPanels(sections)}
      </div>
    </div>
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
