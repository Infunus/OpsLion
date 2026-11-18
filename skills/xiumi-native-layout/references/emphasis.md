# 原生加粗保留、重点强调与同层标题一致性（v2.4.4）

## 三条硬规则

1. 原稿中已加粗的文字必须在成稿对应内容处保留加粗，不能只保留文本内容而丢掉强调。Word 解析要用 `runs` 的 `bold` 标记（包含段落/字符样式的继承加粗），覆盖表格单元格、标题、正文及图注，不仅处理普通 `paragraph.text`。使用 `materials.summary.json`/`materials.json` 的 `runs` 标记核对。
2. 根据稿件语义有节制地增加强调：比分、关键时间、截止日期、主讲人、重要人物与表现、结论等。优先局部加粗，避免标题和大段正文不加区分地全加粗；不要为加粗而改动字词。
3. 同一篇稿件中同级别、同用途的标题文字粗细统一，**默认建议统一加粗**。即使标题来自不同原生组件，也要统一；即使复用同一 `paper-cp:header/1-txt-normal`，只要一个用作图注另一个用作标题，就不应强行视为同类。按角色如 `main_title`、`section_title`、`subsection_title`、`caption` 人工分组。

## 原生实现方式

- 普通 `sequence[*].edits` 仅接受纯文字；用它替换模板已有 `<strong>` 节点时，整个新文字可能变粗；把原本粗的文字换到普通 `<p>` 节点时则会失去加粗。因此**不能把 Word 的加粗属性寄托给普通 edits 自动处理**。
- `richText` 是工作计划内的实例级字段，最终仍编译成标准 `xiumi-bridge/v4` 原生组件树。它安全地将文本片段写入真实富文本 `<strong>`，而不向 `edits` 传 HTML。设置在实例上，不影响来源模板与其他实例。

### 单自然段：部分加粗

```json
{
  "id": "goal-summary",
  "source": 0,
  "richText": [
    {
      "path": ["txt1"],
      "runs": [
        {"text": "本场比赛"},
        {"text": "林子川", "bold": true},
        {"text": "完成帽子戏法，信科"},
        {"text": "4:3", "bold": true},
        {"text": "获胜"}
      ]
    }
  ]
}
```

### 同层标题：全部加粗

```json
{
  "id": "section-title-a",
  "source": 0,
  "richText": [
    {"path": ["txt1"], "runs": [{"text": "赛事回顾", "bold": true}]}
  ]
}
```

对另一个语义层级相同的「首发阵容」「本场之星」使用同一全加粗策略。对于两段及以上的原生文字组件，`richText` 也可以传 `paragraphs: [{"runs":[...]}, ...]`，数量必须与来源组件的原生 `<p>` 数量一致。原文必须完整出现，纯视觉加粗本身不属于文字改动。

**约束**：一个文字 cell 的 `richText` 和 `edits` 不得同时使用；同一 cell 只能二选一，且 `richText` 中的 runs 应组合成该 cell 的全部目标文本。生成器保留原有 `<p>` 外壳及其属性、HTML 转义特殊字符，重新建立 native slots，以免导入插件出现错位。`path` 相对 source 模块，取自真实 `blueprint`，不可照抄上述示意路径。

## 审核

1. 导入前按照源 Word 每个显式与样式继承的加粗 run，逐一比对成稿对应文字片段是否真的仍在 `<strong>/<b>` 或其它有效的原生字重样式内。
2. 建立标题角色清单，同一组成员全部加粗或全部不加粗（推荐全部加粗），不要单靠 tplId 判定。
3. 检查新增强调数量，避免每行和每个词都被加粗，突出信息层级。
4. 使用 `audit_emphasis.py` 生成候选问题：

```bash
python scripts/audit_emphasis.py \
  --source 文案.docx --packet article.xiumi.json \
  --title-groups title-groups.json --out emphasis-audit.json
```

`title-groups.json` 由 AI 根据本稿标题语义制作：

```json
{
  "groups": [
    {"name": "section_title", "titles": ["赛事回顾", "首发阵容", "本场之星"]},
    {"name": "subsection_title", "titles": ["上半场", "下半场"]}
  ]
}
```

**检查范围说明**：脚本比对 Word run 的可识别加粗片段和原生文字 HTML（考虑 run 编辑），并依人工指定的标题组检查整组是否加粗。若使用主题颜色样式、复杂字符样式、文本框、图片内字或特殊继承格式，脚本可能有漏报/误报，不能替代真实秀米视觉检查。报告通过不代表已经在真实秀米保存成功。
