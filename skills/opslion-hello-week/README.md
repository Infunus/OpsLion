# OpsLion Hello Week Skill v4.0.1

**采编 + 文案 + 秀米原生模板 + 一键导入包**，全部合并在一个可长期复用的 Skill ZIP 中。包含旧版 Hello Week Skill 3.1.0 的核心采编工作流，以及基于《Hello Week丨26春 第十周》真实原生组件构建的模板设计（组件设计源 v2.3）。

兼容：**支持 xiumi-bridge/v4 原生协议的 OpsLion 插件**；输出 `xiumi-bridge/v4` 的 `.xiumi.json`。ZIP 不是直接传给插件的导入文件，ZIP 是供 AI 使用的完整 Skill；AI 处理本期资料后会产生可导入的 `.xiumi.json`。

## 交给 AI 的用法

上传整个 ZIP 和本期公众号资料（如 `all-articles.md` / 原文截图），告诉 AI：

> 按这个 Hello Week Skill 生成本期周报，先审核来源、日期、资格和重复信息，再严格按信科本科生相关性选稿，使用原生模板制作可由支持 v4 原生协议的导入端 一键导入的 `.xiumi.json`。默认使用采集到的真实原文地址插入超链接，百讲演出固定留空。

AI 首先读取根目录 `SKILL.md`，按其中的参考文件操作；不是先用素材填满一个固定数量的资讯框。

## 核心功能

- **资料采编**：拆分文章合集、归一日期/期次、筛选有效事件、跨公众号去重、处理补充/改期/取消，保存独立来源证据
- **回顾/预览差异**：回顾只收信科本科生直接相关已发生事项；预览收信科本科生能参加或明确相关的未来事项
- **文案**：内容围绕事件，时间地点和报名截止等必要字段独立呈现；不写已结束活动的无意义报名人数，动态文案段尾不加句号
- **原生排版**：14 类秀米 v5 原生组件，固定栏目骨架，按实际资讯数量增删分类和条目，保留动图、投稿、分类条、正文、代码开结尾和落款
- **百讲演出固定留空**：标题+原生浅蓝方框永远存在，内部只有一个空白原生文本框，供使用者导入后填写
- **固定版式审稿**：栏目骨架与原生蓝色视觉保持一致，检查长标题、信息字段、正文段落和溢出；正文默认无首行缩进，西文打断仅按需要启用；实站视觉另行核验

## 包内文件

| 路径 | 作用 |
| --- | --- |
| `SKILL.md` | 一体化任务入口与优先规则 |
| `references/source-workflow.md` | 素材读取、期次、时间与去重/更正 |
| `references/writing-style.md` | 字段与内容写法、标题、标点 |
| `references/editorial-review.md` | 采编边界场景与审核表 |
| `references/typography-and-layout.md` | 原生文本设置与布局审核 |
| `references/style-samples/` | 旧版 Skill 的四张写法参考图，仅作风格与字段示意 |
| `hello-week.template.json` | **真实原生组件种子**，保留可编辑的秀米结构 |
| `component-guide.md` / `all-modules.md` / `module-index.json` | 14 类原生组件说明和组合 |
| `TEMPLATE_CONTRACT.md` | 当前严格筛选与原生模型约定 |
| `starter.json` / `examples/` | 每期 JSON 数据及六种结构示例，样例事实不能直接发布 |
| `scripts/build.py` | JSON → v4 原生 `.xiumi.json` 成稿 |
| `scripts/audit_content.py` | 轻量文案结构提示，不阻止正常出包 |
| `tests/` | 原生模型、百讲、文字插槽和新采编检查回归测试 |
| `assets/` / `preview/` | 源稿固定视觉资源及离线结构示意（非实站截图） |
| `HelloWeek_原生模板示范稿.xiumi.json` | 有占位内容的**演示稿**，不能直接发布 |

## 最小工作命令

```bash
pip install -r requirements.txt
python scripts/audit_content.py weekly-content.json
python scripts/build.py weekly-content.json -o HelloWeek_本期.xiumi.json
python tests/test_template.py
python tests/test_browser_slots.py
python tests/test_editorial_workflow.py
```

`weekly-content.json` 可从 `starter.json` 复制并填入**本期真实事件**，不存在时 AI 应当从用户素材中制作；**旧版 `:::news` Markdown 不直接输入新版原生生成器**。

打开秀米新建空白图文，使用支持 v4 原生协议的导入端 导入最终 `.xiumi.json`；插件负责写入原生组件和自动保存。离线模型检查无法代替秀米实站渲染。
