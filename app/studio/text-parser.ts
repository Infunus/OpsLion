import { createDefaultSection, makeId, type ArticleContent } from "./types";

const isHeading = (line: string) => {
  const trimmed = line.trim();
  return /^#{1,4}\s+/.test(trimmed)
    || /^[一二三四五六七八九十]+[、.．]\s*/.test(trimmed)
    || /^\d{1,2}[、.．]\s*/.test(trimmed)
    || /^【.+】$/.test(trimmed);
};

const cleanHeading = (line: string) => line
  .replace(/^#{1,4}\s+/, "")
  .replace(/^[一二三四五六七八九十\d]+[、.．]\s*/, "")
  .replace(/^【|】$/g, "")
  .trim();

export function parsePlainText(source: string): ArticleContent {
  const lines = source.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim());
  const nonEmpty = lines.filter(Boolean);
  if (!nonEmpty.length) {
    return { title: "未命名文章", subtitle: "", lead: "", sections: [createDefaultSection()], ending: "" };
  }

  const title = cleanHeading(nonEmpty[0]);
  const sections: ArticleContent["sections"] = [];
  const preface: string[] = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of nonEmpty.slice(1)) {
    if (isHeading(line)) {
      if (current) {
        sections.push({ id: makeId("section"), title: current.title, body: current.body.join("\n\n"), imageUrl: "", imageCaption: "", visible: true });
      }
      current = { title: cleanHeading(line), body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      preface.push(line);
    }
  }

  if (current) {
    sections.push({ id: makeId("section"), title: current.title, body: current.body.join("\n\n"), imageUrl: "", imageCaption: "", visible: true });
  }

  if (!sections.length) {
    const chunks = preface.join("\n").split(/\n{2,}|(?<=[。！？])\s*(?=.{18,})/).filter(Boolean);
    sections.push({
      id: makeId("section"),
      title: "正文",
      body: chunks.join("\n\n") || preface.join("\n"),
      imageUrl: "",
      imageCaption: "",
      visible: true,
    });
    return { title, subtitle: "", lead: "", sections, ending: "" };
  }

  const lead = preface.slice(0, 2).join("\n");
  const ending = preface.length > 2 ? preface.slice(2).join("\n") : "";
  return { title, subtitle: "", lead, sections, ending };
}
