# xiumi-bridge/v4 原生文件协议

## 协议基准

协议字段依据原生抓取与导入实现核对，相关文件：
`manifest.json`, `popup.js`, `bridge-import.js`, `blueprint-core.js`, `blueprint-runtime.js`, `save-new-article.js`, `page-runtime.js`, `payload.js`。

本 Skill 以文件协议与字段能力判断兼容性，不绑定浏览器插件版本。旧版 HTML 模板 `opslion-template/v2`、HTML 成稿 `xiumi-bridge/v3` 均不是本版原生工作流。插件可兼容旧 HTML 包，但本 Skill 不自动降级到 HTML。

## 文件结构

```json
{
  "schema": "xiumi-bridge/v4",
  "mode": "native-layout",
  "title": "成稿标题",
  "nativeLayout": {
    "schema": "opslion-native-layout-plan/v1",
    "blueprint": {
      "schema": "opslion-native-blueprint/v1",
      "adapter": "xiumi-v5-model/0.6.0",
      "source": {"paperId":"真实已保存的数字稿件 ID","url":"真实秀米来源地址"},
      "modules": ["实际原生组件树对象（不是 HTML）"],
      "pageStyle": {"fontSize":"14px"},
      "slots": [{"id":"t:[0,...]:0","kind":"text","module":0,"path":[0,"..."],"run":0,"original":"旧文字"}]
    },
    "sequence": [{"id":"模块唯一名称","source":0,"edits":{"t:[0,...]:0":"新文字"}}]
  }
}
```

上例中的 `"..."` 仅为说明，**不可照抄成真实可导入模板**。`blueprint.modules` 必须来自用户插件抓取的真实树，包含 `_comp`、`colN`、`items`、`txt1`、`img1` 等未知结构，按原样保留。

## 原生文字与图片

- **文字**：`slot.kind=text` 的 `path` 指到 `type=text` 的 cell，含 `cell.text` 富文本 HTML 字符串；`run` 是该 HTML 解析树中一个实际文字节点的编号；`original` 是其旧值。编译 plan 后通过 `edits[slot.id]="纯文字"` 替换文本节点。插件保留行内元素壳，换行转换为 `<br>`。不可将完整任意 HTML 当纯文字写入。
- **图片**：`slot.kind=image` 的 `path` 指到 `type=image` 的 cell，并指明其 `src/url/uri/imageUrl/imageURL` 字段。`edits` 可以是完整公开 HTTP(S) URL，或 `data:image/png|jpeg|gif|webp|avif;base64,...`。插件会上传图到秀米存储。WebP/AVIF 在上传前浏览器本地转 PNG。直接保留已有秀米图地址时，插件可能复用，不一定重新上传。
- **原生文字设置（已核对用户抓取实例）**：秀米“首行缩进”写在文字 cell 的 HTML 段落 `<p style="text-indent: 2em;">`；“西文打断”写在同一 cell 的 `constraint.wordBreakMode="breakAll"` 以及段落 `<p style="word-break: break-all;">`。两项都不应凭空改成外层文字 `style.textIndent`。支持 v4 原生协议的导入端 文本 `edits` 只替换 DOM 文字节点，因此保留原生 `<p>` 标签及其属性；Skill 的 `textFormatting` 会制作实例级变体再替换文字。
- **页面样式**：`blueprint.pageStyle` 原样保留，除非用户要求确切改变全文背景、字号等。排版常见修复集中在单个组的 `style`，不在这里改。
- **编排**：同一 `source` 可以多次出现在 `sequence`，每个实例有独立 `id`、`edits`；每次导入插件会复制组件树并递归生成新 UUID。

## 插件实际限制

来自 `blueprint-core.js` 和 `blueprint-runtime.js`：

- 捕获模块数 1–500；编辑槽位至多 15000；最终顺序模块数 1–1000。
- 捕获组件和页面样式的 JSON 最大约 8,000,000 字符；生成后的展开组件总量也受该限制。
- 每个文字编辑值最多 50,000 字符；图片数据 URI 最多 17,000,000 字符（约 12MB 二进制）。
- 来源必须是**已保存的数字 ID 稿件**；目标不能是来源稿件；目标必须空白。新建但未保存的空白图文可以导入。
- 扩展在当前秀米 v5 编辑模型中插入组件，若目标是未保存新稿，会通过 `onBtnClickSave()` 尝试保存并得到 ID。已经保存的空白稿导入后不强制保存。
- 图片先上传成功，再写入正文；图片上传失败时可能已有图片残留图库，但正文尚未修改。
- 编辑器接口是秀米内部接口，不承诺所有未来版本恒定。

## 验证边界

本 Skill 的本地 Python 工具可核验 JSON、模块引用、路径、图片与原生样式修改，**不能替代秀米渲染器**。原生结构能够被插件接受 ≠ 成稿在微信手机端像素级完整。要证明裁切修复，需要查看真实渲染，条件允许时检查保存重开。

## 原生表格（v2.4.5）

来源组件必须具有 `tplId=paper-cp:layout/classic-table-normal`，其 `classicTable1` 为 `type=classic-table`，含 `thead`、`items` 行及 `tds` 单元格。表格里的文本是嵌套 `type=text` 富文本 cell，不是一个普通 HTML 表格字符串。Skill 新增编排项 `nativeTables` 与导入辅助程序 `scripts/import_native_table.py`，仅复制真实抓取组件、扩展其行并重建新模块的 slots，具体见 `native-tables.md`。纵向 `rowSpan` 合并及缺少真实父容器的滚动布局不自动假造；生成结果需手机视口与真实秀米检查。
