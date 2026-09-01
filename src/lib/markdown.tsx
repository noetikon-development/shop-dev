import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A deliberately small, safe Markdown renderer (Step 16).
 *
 * It renders to React elements — there is NO `dangerouslySetInnerHTML` and no
 * HTML passthrough, so admin-entered content can never inject markup or scripts.
 * Supported: headings (#, ##, ###), paragraphs, unordered/ordered lists,
 * blockquotes, horizontal rules, and inline **bold**, *italic*, `code`,
 * [links](…). Link targets are restricted to internal paths, https URLs and
 * mailto: — anything else renders as plain text.
 */

function safeHref(href: string): string | null {
  const h = href.trim();
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  if (/^https:\/\//i.test(h)) return h;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(h)) return h;
  return null;
}

/** Inline: **bold**, *italic*, `code`, [text](href). Input is plain text. */
function renderInline(text: string, keyOf: () => string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    // Bold / italic may themselves contain a link or code span, so recurse into
    // their content (the captured group never includes the * delimiters, so
    // each recursion works on a strictly shorter string).
    if (m[2] !== undefined) nodes.push(<strong key={keyOf()}>{renderInline(m[2], keyOf)}</strong>);
    else if (m[4] !== undefined) nodes.push(<em key={keyOf()}>{renderInline(m[4], keyOf)}</em>);
    else if (m[6] !== undefined)
      nodes.push(
        <code key={keyOf()} className="rounded-sm bg-surface-sunken px-1 py-0.5 text-[0.85em]">
          {m[6]}
        </code>,
      );
    else if (m[8] !== undefined) {
      const href = safeHref(m[9] ?? "");
      if (href && href.startsWith("/")) {
        nodes.push(
          <Link key={keyOf()} href={href} className="underline underline-offset-2 hover:text-ink">
            {m[8]}
          </Link>,
        );
      } else if (href) {
        nodes.push(
          <a key={keyOf()} href={href} rel="nofollow noopener" className="underline underline-offset-2 hover:text-ink">
            {m[8]}
          </a>,
        );
      } else {
        nodes.push(m[8]);
      }
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  let seq = 0;
  const keyOf = () => `md-${seq++}`;
  const inline = (t: string) => renderInline(t, keyOf);

  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    blocks.push(
      <p key={keyOf()} className="leading-relaxed text-ink-soft">
        {inline(buf.join(" "))}
      </p>,
    );
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === "") {
      i++;
      continue;
    }
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      blocks.push(<hr key={keyOf()} className="my-6 border-line" />);
      i++;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = heading[1].length;
      const cls = level === 1 ? "text-2xl mt-8 first:mt-0" : level === 2 ? "text-xl mt-6" : "text-lg mt-5";
      const Tag = `h${level + 1}` as "h2" | "h3" | "h4";
      blocks.push(
        <Tag key={keyOf()} className={`${cls} font-display text-ink`}>
          {inline(heading[2])}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={keyOf()} className="border-l-2 border-line-strong pl-4 text-ink-soft">
          {inline(quote.join(" "))}
        </blockquote>,
      );
      continue;
    }
    if (/^([-*])\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^([-*])\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^([-*])\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={keyOf()} className="ml-5 list-disc space-y-1.5 text-ink-soft">
          {items.map((it) => (
            <li key={keyOf()}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={keyOf()} className="ml-5 list-decimal space-y-1.5 text-ink-soft">
          {items.map((it) => (
            <li key={keyOf()}>{inline(it)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|>|[-*]\s|\d+\.\s|---+$)/.test(lines[i].trim())
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    flushParagraph(buf);
  }

  return <div className={className ? `${className} space-y-4` : "space-y-4"}>{blocks}</div>;
}
