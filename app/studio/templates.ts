import type { ThemeDefinition } from "./types";

const baseStyle: ThemeDefinition = {
  id: "plain", name: "基础排版", description: "基础文本与图片排版", accent: "#526b5c", swatches: [],
  specification: { page: "白色；左右留白 22px", mainTitle: "28px；左对齐", sectionTitle: "21px；左对齐", body: "15px；行高 1.9", image: "通栏；图注居中", decorations: [] },
  decorativeAssets: [],
};
export const findTheme = (id: string) => ({ ...baseStyle, id: id as ThemeDefinition["id"] });
