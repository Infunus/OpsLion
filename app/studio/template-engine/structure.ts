import type { ArticleNode, HeadingKind, ParsedArticle, SemanticContext } from "./types";

export interface Section { heading: ArticleNode & { type: HeadingKind }; children: Entry[] }
export type Entry = ArticleNode | Section;
export const isSection = (entry: Entry): entry is Section => "heading" in entry;
export const entryNode = (entry: Entry) => isSection(entry) ? entry.heading : entry;
export const headingLevel = (type: string) => /^heading[123]$/.test(type) ? Number(type.slice(-1)) : 0;

export function structureArticle(article: ParsedArticle) {
  const root: Entry[] = []; const stack: Section[] = [];
  for (const node of article.nodes) {
    const level = headingLevel(node.type);
    if (level) {
      while (stack.length && headingLevel(stack.at(-1)!.heading.type) >= level) stack.pop();
      const section: Section = { heading: node as Section["heading"], children: [] };
      (stack.at(-1)?.children ?? root).push(section); stack.push(section);
    } else (stack.at(-1)?.children ?? root).push(node);
  }
  const contexts = new Map<string, SemanticContext>(); const globalCounts = new Map<string, number>(); const indices = new Map<string, number>();
  article.nodes.forEach((node) => { const index = (globalCounts.get(node.type) ?? 0) + 1; globalCounts.set(node.type, index); indices.set(node.id, index); });
  const visit = (entries: Entry[], ancestors: string[]) => {
    const counts = new Map<string, number>();
    entries.forEach((entry, index) => {
      const node = entryNode(entry); const localIndex = (counts.get(node.type) ?? 0) + 1; counts.set(node.type, localIndex);
      contexts.set(node.id, { typeIndexInArticle: indices.get(node.id)!, typeIndexInSection: localIndex, indexInFlow: index + 1, flowLength: entries.length, previousType: index ? entryNode(entries[index - 1]).type : null, nextType: entries[index + 1] ? entryNode(entries[index + 1]).type : null, ancestors });
      if (isSection(entry)) visit(entry.children, [...ancestors, node.id]);
    });
  };
  visit(root, []);
  return { root, contexts };
}
