/** The downloadable definition and the runtime use this same versioned contract. */
export const helloWeekDefinition = {
  schema: "opslion/weekly-template/v1",
  id: "hello-week/v1",
  name: "Hello Week",
  version: "1.2.0",
  input: { marker: "<!-- opslion:hello-week/v1 -->", title: "# 本期周报标题", layout: "<!-- layout: classic | spaced | inset -->", block: ":::模块ID 可选标题\n内容\n:::", maxModules: 500, maxCharacters: 1_000_000 },
  automaticModules: { ids: ["contact", "credits"], copyInstruction: "文案不生成 contact 和 credits。模板自动插入联系区与组织落款，读取本机固定信息；文案、排版、校对的人名一律留空。旧文案中的这两个模块会被模板固定内容替换。", settings: ["email", "contactPerson", "organization"] },
  layouts: {
    classic: { name: "常规", padding: "0px", letterSpacing: "normal", references: [1, 7] },
    spaced: { name: "疏朗", padding: "0px", letterSpacing: "1px", references: [11] },
    inset: { name: "两侧留白", padding: "0px 12px", letterSpacing: "1px", references: [3, 15] },
  },
  assets: {
    banner: { src: "/assets/hello-week/banner.gif", label: "通用栏目横幅", width: "100%" },
    welcome: { src: "/assets/hello-week/welcome.png", label: "通用欢迎装饰", width: "45%" },
    "submission-qr": { src: "/assets/hello-week/submission-qr.png", label: "投稿二维码占位图", width: "80%" },
    avatar: { src: "/assets/hello-week/avatar.gif", label: "通用栏目头像", width: "24px" },
    section: { src: "/assets/hello-week/section.png", label: "黄色对话章节标记", width: "44px" },
    heart: { src: "/assets/hello-week/heart.png", label: "学期收尾装饰", width: "12%" },
    footer: { src: "/assets/hello-week/footer.jpg", label: "通用栏目落款", width: "100%" },
  },
  palette: { ink: "#0f1330", blue: "#89b1e6", link: "#337ab7", panel: "rgba(137,177,230,0.1)", gradient: "linear-gradient(#dbfffe 10%,#ffe0e0 100%)" },
  pageFrame: '<section data-layout-artifact="opslion-hello-week/v1" style="box-sizing:border-box;max-width:100%;padding:{{padding}};background:#fff;color:#3e3e3e;font-family:Arial,\'Microsoft YaHei\',sans-serif;font-size:14px;line-height:28px;letter-spacing:{{letterSpacing}};text-align:justify;overflow-wrap:break-word;">{{modules}}</section>',
  modules: {
    welcome: { name: "开学欢迎", title: "optional", body: "markdown", frame: '<section style="padding:27px;background:linear-gradient(#dbfffe 10%,#ffe0e0 100%);text-align:center;color:#0f1330;">{{heading}}{{body}}</section>' },
    banner: { name: "栏目横幅", title: "none", body: "empty", frame: '{{banner}}' },
    "code-intro": { name: "代码开场", title: "intro-mode", body: "empty", frame: '{{code}}' },
    divider: { name: "箭头分隔", title: "none", body: "empty", frame: '<p style="margin:0;padding:8px 0;font:700 16px/24px Consolas,monospace;color:#000;white-space:nowrap;overflow-wrap:normal;">{{divider}}</p>' },
    callout: { name: "投稿与说明框", title: "required", body: "markdown", frame: '<section style="padding:27px;border:1px solid #89b1e6;background:rgba(137,177,230,0.1);color:#0f1330;">{{commentHeading}}{{body}}</section>' },
    section: { name: "时期与提示分区", title: "required", body: "empty", frame: '<section style="padding:12px 0;text-align:left;">{{sectionIcon}}<strong style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:18px;line-height:28px;max-width:calc(100% - 60px);">{{title}}</strong></section>' },
    category: { name: "资讯类别", title: "required", body: "empty", frame: '<section style="background:rgba(137,177,230,0.1);padding:28px 20px 8px;"><table style="width:100%;border-collapse:collapse;"><tbody><tr><td style="width:112px;vertical-align:middle;"><strong style="display:inline-block;box-sizing:border-box;max-width:100%;padding:12px 18px;background:linear-gradient(125deg,#08ccdd,#0754ff 65%,#2076ee);border:2px solid #fff;border-radius:10px;box-shadow:0 0 3px #08a8e8;color:#fff;font-size:16px;font-weight:700;line-height:24px;text-align:center;">{{title}}</strong></td><td style="vertical-align:middle;padding-left:18px;"><div style="border-top:1px solid #66adff;height:1px;"></div></td></tr></tbody></table></section>' },
    news: { name: "资讯条目", title: "required", body: "news", frame: '<section style="background:rgba(137,177,230,0.1);padding:4px 12px 18px;color:#0f1330;"><p style="display:block;max-width:100%;box-sizing:border-box;margin:0 30px 10px 0;padding:3px 12px;background:#89b1e6;color:#fff;font-size:16px;line-height:28px;font-weight:700;"><strong style="font-size:16px;font-weight:700;color:#fff;">{{title}}</strong></p><section style="padding:0 15px;">{{body}}</section></section>' },
    transition: { name: "代码过渡", title: "none", body: "lines", frame: '{{code}}' },
    notice: { name: "重要提示条目", title: "required", body: "markdown", frame: '<section style="background:rgba(137,177,230,0.1);padding:18px 12px;color:#0f1330;"><p style="display:inline-block;max-width:100%;box-sizing:border-box;margin:0 0 10px;padding:3px 12px;background:#89b1e6;color:#fff;font-size:16px;line-height:28px;font-weight:700;"><strong style="font-size:16px;font-weight:700;color:#fff;">{{title}}</strong></p><section style="padding:0 15px;">{{body}}</section></section>' },
    contact: { name: "联系信息（模板固定）", title: "optional", body: "template", frame: '<section style="margin:20px 0;padding:27px;border:1px solid #89b1e6;background:rgba(137,177,230,0.1);color:#0f1330;font-size:14px;line-height:28px;"><p style="margin:0 0 28px;"><strong style="font-weight:700;">// 【联系我们】</strong></p><p style="margin:0 0 28px;">如果您有<strong style="font-weight:700;">对于学生会组织建设和活动开展的意见和建议</strong>，或是有<strong style="font-weight:700;">需要学生会帮助解决的权益诉求</strong>，欢迎通过以下方式联系我们：</p><p style="margin:0 0 28px;"><strong style="font-weight:700;">学生会公共邮箱：</strong><br>{{email}}</p><p style="margin:0;"><strong style="font-weight:700;">学生会负责人：</strong><br>{{contactPerson}}</p></section>' },
    "code-outro": { name: "代码结束", title: "none", body: "empty", frame: '{{code}}' },
    image: { name: "配图与装饰", title: "none", body: "image", frame: '<section style="text-align:center;padding:8px 0;">{{body}}</section>' },
    closing: { name: "学期收尾", title: "optional", body: "markdown", frame: '<section style="padding:27px;background:linear-gradient(#dbfffe 10%,#ffe0e0 100%);color:#0f1330;text-align:center;">{{heading}}{{body}}</section>' },
    credits: { name: "组织与署名（模板固定）", title: "optional", body: "template", frame: '<section style="padding:0 0 12px;text-align:right;font-size:14px;line-height:28px;font-weight:700;"><p style="margin:0 0 8px;"><strong style="font-weight:700;">{{organization}}</strong></p><p style="margin:0 0 6px;"><strong style="font-weight:700;">文案丨</strong></p><p style="margin:0 0 6px;"><strong style="font-weight:700;">排版丨</strong></p><p style="margin:0 0 6px;"><strong style="font-weight:700;">校对丨</strong></p></section>' },
    footer: { name: "栏目落款海报", title: "none", body: "empty", frame: '{{footer}}' },
    spacer: { name: "段间留白", title: "space-size", body: "empty", frame: '<section style="height:{{height}}px;line-height:{{height}}px;">&#8203;</section>' },
    code: { name: "自定义代码段", title: "none", body: "code", frame: '{{code}}' },
  },
} as const;

export type WeeklyModuleKind = keyof typeof helloWeekDefinition.modules;
export type WeeklyLayout = keyof typeof helloWeekDefinition.layouts;
export interface WeeklyModule { kind: WeeklyModuleKind; title: string; body: string; line: number; bodyLine: number }
export interface HelloWeekDocument { template: "hello-week/v1"; title: string; layout: WeeklyLayout; modules: WeeklyModule[] }
