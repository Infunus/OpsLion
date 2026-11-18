# 秀米原生表格：识别、复制、编辑、导入与审核

适用协议：`xiumi-bridge/v4` + `mode=native-layout`。**原生表格必须取自插件实际抓取的秀米组件**，不能用一段 `<table>` HTML 冒充；不能通过给普通文字 `edits` 塞 HTML 实现表格。

## 1. 什么时候使用

- 原 Word 已经有真正的数据表格：阵容、时间地点、比分、逐分钟赛况、换人名单、费用等，**优先保留为秀米可编辑表格**，不能把不同单元格用顿号或换行挤成普通长段。
- 对“时间／事件”结构，适合 2 列：左列时间或类别，右列事件原文。数字、比分、人物、原文加粗都应保留。
- 原稿若有很多行，不要为了保留旧表格的 5 行容量删掉其余行；应复制原生行，按实际数据扩展。
- 表格若影响窄屏阅读，优先改列宽、单元格 padding、字号、换行、滚动容器，不压缩原始事实。不要无理由把所有正文一概转成表格。

## 2. 真正的原生结构（来自用户提供的“无标题”表格示例）

原始样例在 `examples/native-table.reference.xiumi.json`。这是从实际抓取包裁取的**真实原生表格模块**，只作为可追溯的结构示例，不是 HTML 模板。其核心路径为：

```text
blueprint.modules[0]             # 顶层组件 paper-cp:layout/row1-r1c1
  .col1.items[0]                 # paper-cp:layout/classic-table-normal
    .classicTable1               # type = "classic-table"
      .style                     # 表格宽度（例如 width: "100%"）
      .thead[]                   # 列宽，例如 [{style:{width:"38.00%"}}, {style:{width:"62.00%"}}]
      .items[]                   # 每一行，带原生 _comp 信息
        .tds[]                   # 每个真实单元格
          .colSpan / .rowSpan     # 合并信息，普通单元格均为 1
          .style                  # 原生背景色、边框、内边距等
          .items[0]              # paper-cp:header/1-txt-normal
            .txt1.text           # 原生富文本，例如 <p><strong>米米 VS 秀秀</strong></p>
```

具体 `path` 必须以当前抓取包为准；不要假设每个表格都恰好位于 `col1.items[0]`。保留 `_comp`、`colN`、`classicTable1`、`tds`、`items` 层级。`blueprint.slots` 中的表格文字对应嵌套 text cell，而不是一个平面字符串。

## 3. 模板本来已有原生表格

先运行：

```bash
python S/scripts/native_packet.py prepare --template T.xiumi.json --materials 文案.docx --out W
```

找到 `blueprint.modules[source]` 内的 `paper-cp:layout/classic-table-normal` 和**其组件路径**。在 `composition.plan.json` 的对应 `sequence` 条目内使用 `nativeTables`，例如：

```json
{
  "id": "first-half-events",
  "source": 1,
  "nativeTables": [
    {
      "path": ["col1", "items", 0],
      "columnWidths": [22, 78],
      "rows": [
        ["04′", "林子川连续过人制造机会"],
        ["12′", {"runs": [
          {"text": "GOAL · ", "bold": true},
          {"text": "林子川破门，信科 1:0 城环"}
        ]}],
        ["29′", "城环扳平，比分 1:1"],
        [{"text": "上半场结束 · 信科 2:1 城环", "colSpan": 2}]
      ]
    }
  ]
}
```

上例是**结构示范，球队事件文字仅示意**。排版真实稿件时，必须从用户原文逐个单元格填充，不能照搬示例中的叙事。

`nativeTables` 使用说明：

- `path`：**相对于来源顶层模块**，指向 `tplId=paper-cp:layout/classic-table-normal` 的组件；不是指向 `classicTable1` 对象，也不含最外层来源模块编号。
- `rows`：非空行列表；每行按实际列顺序填充文字。生成器复制抓取到的原生行和单元格，行数可在 **1–200** 间变化；保留原模板的基础配色/斑马纹、边框和组件层级。
- 单元格可以是纯文本字符串，或 `{"text":"内容","bold":true}`，或 `{"runs":[{"text":"强调","bold":true},{"text":"正文"}]}`，或 `{"paragraphs":["第一段",{"runs":[...]}]}`。逐字保留原文及局部加粗；多段内容不应被概括成一句。
- `columnWidths` 可选；其数目必须与抓取原生表格的列数相同，百分比之和为 100。若没有把握，保留原模板列宽。
- `colSpan`：可以将一个单元格跨连续多列，**同一行 `colSpan` 总和必须等于原始列数**。这属于基于已捕获结构的谨慎扩展；导入后仍须检查合并显示。
- `rowSpan`：本版**不自动重建跨行合并**。若来源模板包含非 1 的 `rowSpan`，会拒绝扩行重建；应抓取与目标合并结构一致的真实原生表格，人工校验。不可在 JSON 中猜测跨行占用关系。
- `nativeTables` 直接写入新**原生模块实例**的文字 cell，而非普通文字 `edits`；**不要同时用旧的表格单元格 slot ID 编辑同一张表**，因为行数和 slot 路径已变化。生成器会为新表格重建完整的文字 slot 路径，避免“文字或图片修改与模块不匹配”。
- 单元格原有的加粗标签不会自动替代原稿的实际加粗范围；要用 `runs[].bold` 显式指明，避免“所有第二列自动粗”一类错误。

## 4. 表格在另一份 `.xiumi.json` 示例中

这是很常见的情况：正文模板没有表格，但用户另发了一份真实秀米表格示例。先从**参考包**导入整个原生表格模块（不是将其转成 HTML）。

```bash
python S/scripts/import_native_table.py \
  --target 文章原模板.xiumi.json \
  --reference 原生表格示例.xiumi.json \
  --reference-source 1 \
  --out work/含表格素材的模板.xiumi.json

python S/scripts/native_packet.py prepare \
  --template work/含表格素材的模板.xiumi.json --materials 文案.docx --out work/ready
```

其中 `--reference-source 1` 是**当前示例**表格的模块位置，不是通用固定值。脚本会打印导入后的新 `source` 索引；用它在 `composition.plan.json` 中调用上面的 `nativeTables`。它只把原生组件和 slots 添加到目标 `blueprint`，**不改变来源稿件 ID、全文样式和已有 sequence**。两个来源包必须使用相同 `adapter`，结构不兼容时停止并告知用户。

模板、表格示例的 `blueprint.source.paperId` 各自可能不同，输出仍保留**目标文章模板**的来源信息。导入后如需更改表格外壳的实际位置，可通过 `sequence` 调整顶层模块顺序，而不是复制一段静态表格 HTML。

## 5. 正文里的表格与上下滑动区

如果正文需要表格直接嵌在某个复合组件内部，先检查其真实 `colN.items[]`。如果原模板已有**表格在滚动区内部**，给滚动区所属的顶层模块指定嵌套的 `nativeTables.path` 即可。若来源模板只有单独的表格和单独的纵向滚动组件，**不能把两个独立顶层模块简单相邻排放就宣称表格可以滚动**；需要在原生组件树内真实嵌套，保留滚动父组的高度、`overflow`、子项约束，并重新建立 slots。缺少可信的原生容器结构时不要随意拼造，优先让表格自然向下延展，或先在秀米里制作并抓取可滚动表格示例。

## 6. 样式与质量检查

1. 对照 Word 每张表格的**行数、列数、表头、合并关系及每个实际单元格的完整文字**，避免漏行、漏字、重复合并单元格；不要把 Word 的合并单元格 `row.cells` 的重复映射当作原始数据重复。
2. 仅用真实原生 `style` 修改背景、列宽、边框、单元格 padding、字号等；表格可复用参考的斑马纹，关键进球等若要标色，可在生成后基于**实际存在的单元格样式**调整并重建槽位，不能以假 CSS 模拟。优先保证内容可读，不滥用颜色。
3. 必须保留 Word 中每个单元格原有的加粗，并适量新增进球、关键时间、比分等局部强调。标题及表头字重按同层级规则统一（默认加粗）。
4. 对 320px 与 375px 等窄视口检查列宽、换行、边距，尤其关注窄左列的时间和宽右列的长描述；单元格既不能横向越界，也不能因固定高度裁字。
5. 运行原生协议校验和文案差异审核；`validate --images` 的通过仅证明本地数据结构合法，**不等于真实秀米成功导入或实际手机视觉无误**。
6. 交付时说明**使用了多少张原生表格、原稿中哪些表格重建、是否改动了原文、哪些表格样式做了较大调整**；不需要逐项报告纯粹的列宽与换行，但实际增删字词须列出原文与改文。

如需自动生成固定配色/复杂合并的表格，而当前插件样例不具备相应结构，应明确提出新的参考样例要求或承认限制，不能臆造一个“秀米原生表格”。
