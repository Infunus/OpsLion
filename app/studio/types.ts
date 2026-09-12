import type { LayoutState } from "./template-engine/types";
import type { Submission } from "./submission/types";
import type { CaptureSource, SourceLocation } from "./bridge-contract";

export type ThemeId = "plain" | "warm" | "formal" | "vibrant";
export type Density = "compact" | "comfortable";
export type StudioMode = "compose" | "clone" | "weekly";

export interface ContentSection {
  id: string;
  title: string;
  body: string;
  imageUrl: string;
  imageCaption: string;
  visible: boolean;
}

export interface ArticleContent {
  title: string;
  subtitle: string;
  lead: string;
  sections: ContentSection[];
  ending: string;
}

export interface CloneSlot {
  richContent?: import("./template-engine/types").RichText;
  id: string;
  label: string;
  kind: "text" | "image";
  value: string;
  originalValue: string;
  prefix?: string;
  suffix?: string;
  linkUrl?: string;
  originalLinkUrl?: string;
  role?: "content" | "content_image" | "decoration" | "unknown";
  sourceLocation?: SourceLocation;
}

export interface CloneModule {
  id: string;
  label: string;
  included: boolean;
  repeatable: boolean;
}

export interface PendingTemplateAsset {
  id: string;
  kind: "image";
  purpose: string;
  preferredSlotId?: string;
  reason: string;
  imageUrl?: string;
  imageCaption?: string;
}

export interface CloneTemplateState {
  unplacedContent?: Array<{ id: string; kind: string; text: string; content?: import("./template-engine/types").RichText }>;
  excludedContent?: Array<{ id: string; text: string; reason: string }>;
  name: string;
  sourceHtml: string;
  analyzedHtml: string;
  slots: CloneSlot[];
  modules: CloneModule[];
  pendingAssets?: PendingTemplateAsset[];
  draftWarnings?: string[];
  source?: CaptureSource;
  analyzedAt: string;
}

export interface SavedCloneTemplate {
  id: string;
  name: string;
  template: CloneTemplateState;
  createdAt: string;
  updatedAt: string;
}

export interface StudioProject {
  workflow?: import("./workflow/types").Workflow;
  id: string;
  name: string;
  mode: Exclude<StudioMode, "weekly">;
  theme: ThemeId;
  density: Density;
  accentOverride: string;
  content: ArticleContent;
  cloneTemplate: CloneTemplateState | null;
  layout?: LayoutState | null;
  submission?: Submission | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompatibilityIssue {
  level: "info" | "warning" | "error";
  title: string;
  detail: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  accent: string;
  swatches: string[];
  specification: {
    page: string;
    mainTitle: string;
    sectionTitle: string;
    body: string;
    image: string;
    decorations: string[];
  };
  decorativeAssets: Array<{
    name: string;
    src: string;
    placement: string;
    width: number;
  }>;
}

export const makeId = (prefix: string) => {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
};

export const createDefaultSection = (index = 0): ContentSection => ({
  id: makeId("section"),
  title: index === 0 ? "活动预告" : "新的内容模块",
  body: index === 0
    ? "把一段普通文案，整理成清晰、克制、适合手机阅读的公众号文章。"
    : "在这里填写正文。建议每个模块只表达一个核心信息。",
  imageUrl: "",
  imageCaption: "",
  visible: true,
});

export const createDefaultProject = (stableKey = ""): StudioProject => {
  const now = new Date().toISOString();
  const firstSection = { ...createDefaultSection(0), ...(stableKey ? { id: `section-${stableKey}-1` } : {}) };
  const secondSection = { ...createDefaultSection(1), ...(stableKey ? { id: `section-${stableKey}-2` } : {}) };
  return {
    id: stableKey ? `project-${stableKey}` : makeId("project"),
    name: "未命名推文",
    mode: "compose",
    theme: "plain",
    density: "comfortable",
    accentOverride: "",
    content: {
      title: "把每一次表达，都认真排好",
      subtitle: "",
      lead: "好的排版不应该喧宾夺主。它让信息被看见，也让情绪被感受到。",
      sections: [
        firstSection,
        {
          ...secondSection,
          title: "本期看点",
          body: "保留信息密度，也保留阅读时的呼吸感。模板负责稳定，内容由你掌控。",
        },
      ],
      ending: "愿每一份认真准备的内容，都被温柔地看见。",
    },
    cloneTemplate: null,
    createdAt: now,
    updatedAt: now,
  };
};
