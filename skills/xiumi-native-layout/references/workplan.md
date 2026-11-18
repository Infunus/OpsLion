# 新版工作计划与原生布局修补

`native_packet.py` 使用轻量的 `opslion-native-workplan/v1` **中间工作计划**；该计划只在 AI 本地工作，**最终输出仍是插件直接导入的标准 `xiumi-bridge/v4` 文件**。用户不需看到或修改中间工作计划。

**特别提醒**：`prepare` 产生两份计划：`layout.plan.json` 复写原稿 `sequence`，只供无损回导或基于旧成稿做增量修订；**`composition.plan.json` 默认使用空 `sequence`，用于按新文案自由编排新稿**。二者均是本地中间文件，不是插件直接导入包。先根据当前文案形成内容大纲与组件语义清单，再填 `composition.plan.json`，不要直接把旧顺序逐项套新内容。原稿与成稿完全可以具有不同模块数量和顺序。

## 准备与检查

```bash
python S/scripts/native_packet.py prepare --template /path/模板.xiumi.json --materials /path/文案.docx /path/图片.zip --out /path/work
python S/scripts/native_packet.py inspect /path/模板.xiumi.json --out /path/work/catalog.json
```

`catalog.json` 列出所有 `slots`，文字旧值、来源模块、路径，以及文本 cell 当前是否包含原生段首缩进/西文打断；省略大段 base64。若不需要变更，请直接使用原始导入包即可。**不要手写猜测 slot ID。**

## 计划结构

```json
{
  "schema": "opslion-native-workplan/v1",
  "title": "更新后的文章标题",
  "sequence": [
    {
      "id": "section-a",
      "source": 0,
      "edits": {
        "t:[0,\"col1\",\"items\",0,\"txt1\"]:0": "更新后的栏目标题和补充说明"
      },
      "stylePatches": [
        {
          "path": ["col1", "style", "height"],
          "expected": "40px",
          "value": "auto"
        }
      ]
    }
  ]
}
```

**注意：**这是刻意简化的合成数据，用于展示 `edits` 与 `stylePatches` 的字段及作用，`height: auto` 并非默认修复方案。先读取当前模板的真实路径和属性，根据实际可视证据确定改动；不要直接复制这段示例到真实稿件。

每个 `sequence` 条目有：

- `id`：本轮模块唯一名称，便于跟踪与排序
- `source`：从 `blueprint.modules` 中取第几个顶层原生组件（从 0 开始）
- `edits`：该 source 下的原始 slot ID → 字符串（文字或图片 URL/base64）
- 图片 `edits` 也可写 `{ "asset": "A0001" }`，编译器从 `materials.json` 自动内嵌，用户不需要预上传
- `stylePatches`（可选）：在选定**模块实例**中修改**已有**的原生 `style/pose/constraint` 属性；不允许凭空追加未知原生样式字段。用于布局调整、宽高、已有 `flex` 等。
- `textFormatting`（可选）：给本模块实例中的特定**原生文字 cell**设置首行缩进和西文打断，使用秀米实际字段，无需手工改写富文本 HTML。例如 `{"path":["txt1"],"firstLineIndent":"2em"}` 或 `{"path":["txt1"],"westernBreak":true}`；可两项一起使用。路径实际可能嵌套在 `colN/items` 中，需检查模板。

- `nativeTables`（可选）：根据真实抓取的 `paper-cp:layout/classic-table-normal`，为指定组件路径生成本期完整表格数据（可动态增减行、指定列宽、局部加粗、可验证的横向合并）。该组件必须已存在于当前模板的 `blueprint.modules`；单独的参考表格要先用 `scripts/import_native_table.py` 导入。格式与示例见 `native-tables.md`。

- `richText`（可选）：原稿含有**局部加粗**或需要主动局部强调时，给特定原生文字 cell 提供完整文字 runs（其中 `bold: true` 的文字生成 `<strong>`），例如 `{"path":["txt1"],"runs":[{"text":"林子川","bold":true},{"text":"完成帽子戏法"}]}`。**与同 cell 的 edits 互斥**；生成器自动为此实例创建新原生模块及正确 slots，保留原始模板其他实例。多自然段使用 `paragraphs` 且数量必须与来源 `<p>` 一致，详见 `emphasis.md`。

### stylePatches 执行原理

对这一实例复制来源 `blueprint.modules[source]`，修改它已有的 `style/pose/constraint` 属性，追加为新的来源模块；同步复制其 `slots`，更新所有 `module/path/id` 和当前实例的 edits key；其余使用原 source 的实例保持完全原样。导入端在写入原生模型时再生成 UUID。**这样不需要把修复应用到所有重复的标题或图文模块。**

`path` 相对于顶层源模块，不带最外层 `source` 数字。`expected` 必须等于当前真实属性的值，这只是一种局部路径定位条件，**不计算任何模板 hash**。若路径无效，人工分析原因再修正，不绕过定位检查。

### textFormatting 的原生行为

对指定 `type=text` 的 cell 生成独立实例变体：

- `firstLineIndent: "2em"`：给每个已有 `<p>` 标签的 `style` 写入 `text-indent: 2em;`，保留已有其他行内样式
- `westernBreak: true`：写入 `cell.constraint.wordBreakMode = "breakAll"`，同时给各自然段的 `style` 加 `word-break: break-all;`
- 原文纯文字 `edits` 仍按原 slot 的文字节点修改，**不能在 edits 中放入 `<p>` 或 HTML**。导入器会保留富文本段落壳。
- `textFormatting` 同样是实例级修改，不影响以相同 `source` 复用的其他模块。若 cell 没有原生 `<p>`，不猜测组件形式，生成器直接报告错误。

示例（以实际路径为准）：

```json
"textFormatting": [
  { "path": ["col1", "items", 0, "txt1"], "firstLineIndent": "2em", "westernBreak": true }
]
```

**选项建议：** 中文叙事自然段按需缩进；连续超长英文/URL 导致折行风险时按需开启西文打断，普通英文不要一律打断。详见 `typography.md`。

### 局部加粗不会通过普通 edits 传递

Word `materials.json` 已含文字 runs 的 `bold` 标记。生成时根据每个段落的原有加粗和必要新增强调，组合出 `richText` runs；保留原文文字内容。**禁止在普通 edits 字符串中直接传 `<strong>` HTML**，导入端会把它当普通文字而不是富文本。多个相同语义层级标题应统一 `<strong>`，优先加粗。

### 图片来源与替换

生成期间 `W/materials.json` 的素材含真实 `src` Base64；计划中使用素材 ID 即可。若用户已有 HTTPS 素材地址，直接写入完整 URL。不修改 `blueprint.slots[*].original`，它始终描述来源的原始值。

### 原始包已是 AI 成稿

`prepare` 会将当前 `sequence` 和已填入的 `edits` 放入 `layout.plan.json`。修改它就能对旧成稿继续改字、重排或修正原生样式；**不要重新从原始模板填充造成之前修正失效**。可选择继续沿用已经生成的 `blueprint.modules`（若含旧 style variants）及其 `slots`。

## 生成与核验

```bash
python S/scripts/native_packet.py build --template W/template.xiumi.json --plan W/composition.plan.json --materials W/materials.json --out D/article.xiumi.json --audit-out D/audit.json
python S/scripts/native_packet.py validate D/article.xiumi.json --images
```

工具不会自动把警告理解为“必改”：阅读 `audit.json` 的 `risks`、`unchangedSourceText`，结合真实截图判断。运行静态审核并不等于已检查真实秀米页面。
