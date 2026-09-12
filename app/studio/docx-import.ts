import { makeId, type ArticleContent, type ContentSection } from "./types";

export interface DocxImportResult {
  article: import("./template-engine").ParsedArticle;
  bundle: import("./semantic-agent").SemanticBundle;
  content: ArticleContent;
  imageCount: number;
  warnings: string[];
}

const baseName = (filename: string) => filename.replace(/\.docx$/i, "").trim() || "未命名文章";

const blockText = (element: Element) => {
  if (element.tagName === "UL" || element.tagName === "OL") {
    return Array.from(element.querySelectorAll(":scope > li"))
      .map((item, index) => `${element.tagName === "OL" ? `${index + 1}.` : "•"} ${item.textContent?.trim() || ""}`)
      .filter((item) => item.replace(/^[•\d.\s]+/, ""))
      .join("\n");
  }
  if (element.tagName === "TABLE") {
    return Array.from(element.querySelectorAll("tr"))
      .map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => cell.textContent?.trim() || "").join(" ｜ "))
      .filter(Boolean)
      .join("\n");
  }
  return element.textContent?.replace(/\s+/g, " ").trim() || "";
};

const createSection = (title = ""): ContentSection => ({
  id: makeId("section"),
  title,
  body: "",
  imageUrl: "",
  imageCaption: "",
  visible: true,
});

const softHeadingTitle = (text: string) => {
  const normalized = text.trim().replace(/[：:]$/, "").trim();
  if (!normalized || normalized.length > 24 || /[。！？；]/.test(normalized)) return "";
  if (/^(活动介绍|活动信息|活动安排|节目要求|主持人要求|征集要求|报名信息|报名方式|参与方式|时间地点|日程安排|注意事项|联系方式|奖项设置|作品要求)$/.test(normalized)) return normalized;
  if (/^[\p{Script=Han}A-Za-z0-9·（）()—-]{2,18}(要求|须知|安排|信息|方式|流程|说明)$/u.test(normalized)) return normalized;
  return "";
};

const inferredSectionTitle = (text: string) => {
  if (/^(有意报名|报名请|请扫描|请扫码|扫描下方|扫码报名|报名方式为)/.test(text.trim())) return "报名信息";
  return "";
};

const likelyStandaloneTitle = (text: string) => {
  const normalized = text.trim();
  const sentenceMarks = normalized.match(/[，。！？；]/g)?.length || 0;
  return normalized.length <= 54 && sentenceMarks <= 1 && !/^[•·\-—]/.test(normalized);
};

export function contentFromDocxHtml(html: string, filename: string): Pick<DocxImportResult, "content" | "imageCount"> {
  const documentValue = new DOMParser().parseFromString(html, "text/html");
  const blocks = Array.from(documentValue.body.children);
  const sections: ContentSection[] = [];
  const preface: string[] = [];
  let title = baseName(filename);
  let titleFound = false;
  let current: ContentSection | null = null;
  let imageCount = 0;

  const pushCurrent = () => {
    if (!current) return;
    if (current.title || current.body || current.imageUrl) sections.push(current);
    current = null;
  };

  for (const block of blocks) {
    const tag = block.tagName.toUpperCase();
    const text = blockText(block);
    const images = Array.from(block.querySelectorAll("img"));
    const explicitHeading = /^H[1-6]$/.test(tag);
    const softHeading = !explicitHeading && images.length === 0 ? softHeadingTitle(text) : "";
    if ((explicitHeading || softHeading) && text) {
      if (!titleFound && tag === "H1") {
        title = text;
        titleFound = true;
      } else {
        // A heading-like first paragraph means the DOCX omitted a styled title.
        // Keep the filename as title instead of consuming the following body as one.
        if (!titleFound) titleFound = true;
        pushCurrent();
        current = createSection((softHeading || text).replace(/[：:]$/, "").trim());
      }
      continue;
    }

    if (!titleFound && text && images.length === 0) {
      titleFound = true;
      if (likelyStandaloneTitle(text)) title = text;
      else preface.push(text);
      continue;
    }

    const inferredHeading = images.length === 0 ? inferredSectionTitle(text) : "";
    if (inferredHeading && current?.title !== inferredHeading) {
      pushCurrent();
      current = createSection(inferredHeading);
    }

    if (!current && !preface.length && images.length === 0 && text && !inferredHeading) {
      preface.push(text);
      continue;
    }

    if (!current) current = createSection("活动介绍");
    if (text) current.body = [current.body, text].filter(Boolean).join("\n\n");
    for (const image of images) {
      if (current.imageUrl) {
        pushCurrent();
        current = createSection();
      }
      current.imageUrl = image.getAttribute("src") || "";
      current.imageCaption = image.getAttribute("alt") || "";
      imageCount += 1;
      pushCurrent();
      current = createSection();
    }
  }
  pushCurrent();

  if (!sections.length) {
    const [lead = "", ...body] = preface;
    sections.push({ ...createSection("正文"), body: body.join("\n\n") || lead });
    return {
      content: { title, subtitle: "", lead: body.length ? lead : "", sections, ending: "" },
      imageCount,
    };
  }

  return {
    content: { title, subtitle: "", lead: preface.join("\n\n"), sections, ending: "" },
    imageCount,
  };
}

export async function importDocx(file: File): Promise<DocxImportResult> {
  const { extractWordSnapshot } = await import("./word-snapshot");
  const { wordArticle } = await import("./word-conversion");
  const { articleToLegacyContent } = await import("./template-engine");
  const bundle = await extractWordSnapshot(file);
  const article = wordArticle(bundle, makeId("article"));
  return { article, bundle, content: articleToLegacyContent(article), imageCount: bundle.images.size, warnings: bundle.request.source.warnings };
}
