# 秀米原生排版 Skill v2.4.5

适用于 **xiumi-bridge/v4、mode=native-layout** 原生文件协议，不绑定浏览器插件版本。

本 Skill 的目标：用户提供插件抓取的 `.xiumi.json` 原生模板及本期材料 → AI 自动制作原生成稿 `.xiumi.json` → 用户用同一插件直接导入秀米。

## 包含内容

- `SKILL.md`：给 AI 的工作规则、审稿与自主修改流程
- `references/`：**素材库语义编排**、中文段落排版、真实 v4 格式、实例级布局修复、材料审稿和验证边界
- `scripts/native_packet.py`：准备/检查/构建/审核完整原生 v4 包（含 `richText` 局部加粗支持）
- `scripts/import_native_table.py`：从单独的原生表格示例抓取包导入真实表格模块（只添加到目标素材库）
- `scripts/native_packet.py`：新增 `nativeTables`，按实际原生单元格结构扩行、设置列宽与局部加粗
- `references/native-tables.md`：原生表格结构、复制、编排、合并与兼容性检查步骤
- `scripts/audit_emphasis.py`：检查原稿粗体保留和同层标题加粗一致性
- `scripts/materials.py`、`scripts/xiumi_dom.py`：旧版成熟的 Word、ZIP 与图片内容提取程序
- `examples/`：轻量的格式示例，**仅用于演示，不是实际秀米母版**
- `tests/`：本地测试与样例生成

## 面向 AI 的基本命令

```bash
python scripts/native_packet.py prepare --template 模板.xiumi.json --materials 文案.docx 素材.zip --out work
python scripts/native_packet.py build --template work/template.xiumi.json --plan work/composition.plan.json --materials work/materials.json --out article.xiumi.json --audit-out audit.json
python scripts/native_packet.py validate article.xiumi.json --images
python scripts/native_packet.py audit article.xiumi.json --out audit.json
python scripts/audit_emphasis.py --source 文案.docx --packet article.xiumi.json --title-groups title-groups.json --out emphasis-audit.json
python scripts/verify_source_fidelity.py --source 文案.docx --packet article.xiumi.json --out content-diff.json
python scripts/verify_source_fidelity.py --source 文案.docx --packet article.xiumi.json --changes content-changes.json --out content-review.json --markdown-report 文案改动说明.md
python -m unittest discover -s tests -v
```

`prepare` 会生成 `catalog.json`（组件目录）、`layout.plan.json`（原稿顺序参考）及 `composition.plan.json`（**新稿默认空白编排**）。制作新文章应由 AI 根据文案填好 `composition.plan.json` 后 `build`；对已有成稿做小幅修订才考虑使用 `layout.plan.json`。未提供新素材时省略 `--materials`。以上是 AI 内部工作命令，用户无需自己执行。

## 原生表格使用（v2.4.5）

如果原稿包含赛况、名单、时间地点等表格，应保留原生行列及每个单元格文字。直接复用本模板真实表格；若表格另在一个抓取包中，先通过 `scripts/import_native_table.py` 导入真实组件，再在 `composition.plan.json` 中填写 `nativeTables`。它支持动态行数、列宽、单元格加粗以及已证实的横向合并，保持原生结构与可编辑性。

使用示例：

```bash
python scripts/native_packet.py build --template examples/native-table.reference.xiumi.json --plan examples/native-table.workplan.json --out /tmp/native-table-demo.xiumi.json
python scripts/native_packet.py validate /tmp/native-table-demo.xiumi.json
```

具体步骤及限制见 `references/native-tables.md`。请勿以 HTML `<table>` 或普通长文本冒充原生表格。

## 特别强调

- **抓取包和成稿包使用相同的 v4 原生协议**
- 原生组件保真：保留模板的真实层级与可编辑性
- **原生素材库式排版**：先理解本期文案，再识别可用的标题、正文、分割线、图片、图注等组件，按内容需要重新组合；抓取包原有模块顺序不作约束
- **默认原文一字不改 + 允许合理排版微调 + 改动披露**：通常保持原字原句；但遇到居中孤字行等问题，可手动断行，或适当删一两个冗余字、微调词语/标点。纯断行是视觉调整，实际改字须记录原文、修改后内容和原因。保留品牌尾图与图片语义位置
- **加粗保真与视觉强调**：Word 原稿中加粗的字词必须保留；比分、日期、重点人物可适度新增局部加粗；同层标题优先统一加粗。局部加粗采用 `richText` 生成真正的 `<strong>`，交付前运行加粗审查
- **秀米原生文本设置**：根据段落位置、功能、容器宽度及整体视觉决定对齐、分行与**是否**缩进；不因长就自动加首行缩进。需要缩进时使用原生 `<p style="text-indent: 2em;">`，长英文/URL 确有折行风险时再使用“西文打断”（`wordBreakMode: breakAll` + 段落 `word-break: break-all`）
- `textFormatting` 是实例级编排选项；以 v4 原生文件协议判断兼容，不会把文字排版混进 HTML v3 旧格式
- 通用排版审核：覆盖文本、图片、遮挡、模块边界、层级与多视口布局问题
- 以实际模板和可见证据为依据，仅做最小必要修复，不预设某一种故障或固定修法
- 图片在成稿包内嵌，由浏览器插件自动上传秀米图库
- 不在插件添加防御性哈希或额外的排版编辑界面

此包是 **AI Skill**，不是浏览器扩展；导入端能处理上述协议及必需字段即可使用，不按插件版本号判断。

## 运行依赖

原生生成器使用 Python 标准库；Word 加粗审核脚本需要 `python-docx`。执行审核或运行完整测试前，在 AI 执行环境中运行 `python -m pip install -r requirements.txt`。
