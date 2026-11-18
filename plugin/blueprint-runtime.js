/**
 * Xiumi v5 native blueprint engine, executed in the selected editor's MAIN world.
 * Uses the live Xiumi v5 editor model; the popup can invoke Xiumi's own save handler after import.
 * Capture: serialize real components, including nested groups, native styles, text, images and metadata.
 * Generate: insert copies into an EMPTY draft (including unsaved #/paper/for/new).
 * No arbitrary HTML->component reconstruction; unknown native structures remain intact.
 */
export async function nativeBlueprintInPage(request = {}, action = "capture") {
  const LOCK = "__opslionNativeBlueprintBusy_v1";
  let ownsLock = false;
  try {
    // Avoid Chrome extension's object-argument serialization changing the native
    // model on its way to the page. The extension sends a JSON string instead.
    if (typeof request === "string") request = JSON.parse(request);
    const fail = (s) => { throw new Error(s); };
    if (location.hostname !== "xiumi.us" || !location.hash.startsWith("#/paper/")) fail("请打开秀米 v5 图文编辑页");
    if (window[LOCK]) fail("另一次导入尚未完成");
    if (action === "apply") { window[LOCK] = true; ownsLock = true; }
    const $ = window.jQuery || window.$, angular = window.angular;
    const injector = angular?.element(document.body).injector() || angular?.element(document.documentElement).injector();
    if (!injector || typeof $ !== "function") fail("秀米编辑器尚未初始化");
    const manager = injector.get("tower").require("editingManager");
    const pages = injector.get("tnScrolledPageManager");
    const active = pages.getActivePage();
    const pageEl = active?.find(".tn-page-inst");
    const pageInst = pageEl?.compInst();
    const rootGroup = pageEl?.find(".tn-comp-slot").cellInst();
    const model = rootGroup?.cellArray;
    const pageStyle = pageInst?.comp?._comp?.style;
    if (!Array.isArray(model) || !pageStyle || !rootGroup?.cellPath || !pageInst?.compPath
        || manager?.config("showType") !== "paper"
        || !["beginBatch", "endBatch", "update", "insert", "remove"].every((k) => typeof manager[k] === "function"))
      fail("没有找到兼容的秀米 v5 原生编辑接口，未修改稿件");
    const paperId = () => {
      const id = location.hash.match(/\/paper\/for\/(\d+)/)?.[1] || "";
      return /^[1-9]\d*$/.test(id) ? id : "";
    };
    const initialPaper = paperId();
    const dialog = () => [...document.querySelectorAll('.modal,[role="dialog"]')].some((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== "hidden");
    if (dialog() || document.activeElement?.isContentEditable) fail("请先结束文字输入并关闭秀米对话框");
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const forbidden = (k) => ["__proto__", "prototype", "constructor"].includes(k);
    const stable = (v) => {
      if (Array.isArray(v)) return v.map(stable);
      if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).filter((k) => k !== "$$hashKey").sort().map((k) => [k, stable(v[k])]));
      return v;
    };
    const clone = (v) => JSON.parse(JSON.stringify(v));
    // 只保留结构化 JSON 抓取，不计算或要求任何哈希值。
    const parse = (html) => { const t = document.createElement("template"); t.innerHTML = html; return t; };
    const textRuns = (html) => {
      const holder = parse(html);
      const root = holder.content;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const out = []; while (walker.nextNode()) out.push(walker.currentNode);
      return { holder, root, out };
    };
    const safeValue = (s) => typeof s === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
    const imageSource = (v) => typeof v === "string" && v.trim().length > 0;
    const scan = (mods) => {
      const slots = []; let nodes = 0;
      function walk(obj, path, depth) {
        if (!obj || typeof obj !== "object") return;
        if (++nodes > 100000 || depth > 60) fail("组件嵌套层数或节点数超过安全限制");
        if (!Array.isArray(obj) && obj.type === "text" && typeof obj.text === "string") {
          const { out } = textRuns(obj.text);
          if (out.length === 0) slots.push({ id: `t:${JSON.stringify(path)}:0`, kind: "text", module: path[0], path, run: 0, original: "", empty: true });
          else out.forEach((n, index) => {
            if (n.nodeValue && n.nodeValue.trim()) slots.push({ id: `t:${JSON.stringify(path)}:${index}`, kind: "text", module: path[0], path, run: index, original: n.nodeValue });
          });
        }
        if (!Array.isArray(obj) && obj.type === "image") {
          // Images use different native cell shapes. Prefer the cell's direct src field;
          // never guess an unrelated metadata URL inside a complicated component.
          for (const field of ["src", "url", "uri", "imageUrl", "imageURL"]) {
            if (typeof obj[field] === "string" && imageSource(obj[field])) {
              slots.push({ id: `i:${JSON.stringify([...path, field])}`, kind: "image", module: path[0], path, field, original: obj[field] });
              break;
            }
          }
        }
        for (const [k, v] of Object.entries(obj)) {
          if (forbidden(k)) fail("原生组件存在不安全的属性");
          if (k === "$$hashKey") continue;
          if (v && typeof v === "object") walk(v, [...path, Array.isArray(obj) ? Number(k) : k], depth + 1);
        }
      }
      mods.forEach((m, i) => walk(m, [i], 0));
      if (slots.length > 15000) fail("文本和图片编辑位置过多，请缩小模板范围");
      return slots;
    };
    const isBlankDraft = () => model.length <= 3 && model.every((m) => {
      let empty = true;
      const walk = (o) => {
        if (!o || typeof o !== "object" || !empty) return;
        if (o.type === "text" && typeof o.text === "string" && parse(o.text).content.textContent?.trim()) empty = false;
        if (o.type === "image" && (o.src || o.url || o.uri)) empty = false;
        if (["video", "audio", "music"].includes(o.type)) empty = false;
        for (const [k, v] of Object.entries(o)) if (k !== "$$hashKey" && k !== "_comp" && v && typeof v === "object") walk(v);
      };
      walk(m); return empty;
    });

    // A brand-new unsaved editor already has a usable component model.
    // Import into that model directly; persist the finished article once after writing.
    if (!initialPaper && action === "capture") fail("请先将原模板保存在秀米，再抓取原生排版");
    if (action === "capture") {
      // Match the exact JSON representation downloaded by the extension.
      const before = { modules: stable(model), pageStyle: stable(pageStyle) };
      const slots = scan(before.modules);
      if (paperId() !== initialPaper) fail("抓取过程中切换了稿件，请重新点击抓取");
      const blueprint = {
        schema: "opslion-native-blueprint/v1", adapter: "xiumi-v5-model/0.6.0",
        capturedAt: new Date().toISOString(), source: { paperId: initialPaper, url: location.href },
        modules: before.modules, pageStyle: before.pageStyle, slots,
      };
      return { ok: true, blueprint, message: `完整抓取 ${blueprint.modules.length} 个原生组件、${slots.filter((s) => s.kind === "text").length} 个文字片段、${slots.filter((s) => s.kind === "image").length} 张可更换图片。` };
    }
    if (action !== "apply") fail("未知的原生模板指令");
    const plan = request.plan;
    if (plan?.schema !== "opslion-native-layout-plan/v1") fail("需要原生布局生成方案");
    const b = plan.blueprint;
    if (b?.schema !== "opslion-native-blueprint/v1" || !b.source || !/^\d+$/.test(b.source.paperId || "")
        || b.source.paperId === initialPaper || !Array.isArray(b.modules) || !b.modules.length || b.modules.length > 500
        || !b.pageStyle || typeof b.pageStyle !== "object" || Array.isArray(b.pageStyle)
        || !Array.isArray(b.slots) || b.slots.length > 15000)
      fail("来源模板格式有误，或当前打开的是原模板。请在新建的空白草稿中生成");
    const modelBytes = JSON.stringify({ modules: b.modules, pageStyle: b.pageStyle }).length;
    if (modelBytes > 8_000_000) fail("导入包组件数据超过 8MB，请拆分模板");
    if (!Array.isArray(plan.sequence) || !plan.sequence.length || plan.sequence.length > 1000) fail("方案模块数必须在 1–1000 之间");
    const inspect = (v, d = 0, counter = { n: 0 }) => {
      if (++counter.n > 100000 || d > 60) fail("导入模型嵌套过深或数据过大");
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
        if (forbidden(k)) fail("模板包含非法属性名称");
        if (typeof x === "string" && /^\s*(javascript|vbscript):/i.test(x)) fail("模板包含不安全的链接");
        if (k === "text" && typeof x === "string" && /<\s*\/?\s*(?:script|iframe|object|embed|form)\b|\bon[a-z]+\s*=/i.test(x)) fail("模板中有不支持的可执行 HTML");
        inspect(x, d + 1, counter);
      }
    };
    inspect({ modules: b.modules, pageStyle: b.pageStyle });
    const slots = new Map();
    for (const s of b.slots) {
      if (!s || typeof s.id !== "string" || slots.has(s.id) || !["text", "image"].includes(s.kind)
          || !Number.isInteger(s.module) || s.module < 0 || s.module >= b.modules.length
          || !Array.isArray(s.path) || s.path[0] !== s.module) fail("模板的编辑位置有误");
      slots.set(s.id, s);
    }
    if (!isBlankDraft()) fail("目标草稿含有正文或现有组件，请打开一份空白图文再导入");
    const sourcePath = (obj, path) => {
      let v = obj;
      for (const k of path) { if (forbidden(String(k)) || !v || typeof v !== "object" || !own(v, k)) fail("原生片段路径失效"); v = v[k]; }
      return v;
    };
    const staged = [];
    const changed = { text: 0, image: 0 };
    const uploads = new Set(); const uploadUpdates = [];
    const safeSrc = (raw) => {
      if (typeof raw !== "string" || !raw.trim()) fail("新图片地址为空");
      if (/^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(raw)) {
        if (raw.length > 17_000_000) fail("单张图片超过 12MB");
        return raw;
      }
      let u; try { u = new URL(raw, "https://xiumi.us"); } catch { fail("图片地址需要完整的 HTTP(S) 地址"); }
      if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || /^(localhost|.*\.local|.*\.localhost|0\.0\.0\.0|\[|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u.hostname)) fail("不能加载非公开或内网图片");
      return u.href;
    };
    const hosted = (s) => { try { const h = new URL(s).hostname; return /(^|\.)xiumi\.us$|(^|\.)xiumius\.cn$/.test(h); } catch { return false; } };
    const uuid = () => {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      const arr = crypto.getRandomValues(new Uint8Array(16));
      return "comp-" + [...arr].map((v) => chars[v % chars.length]).join("");
    };
    const rekey = (root) => {
      function walk(o) {
        if (!o || typeof o !== "object") return;
        // 组件可能在深层组合中嵌套；逐个重设 UUID，避免复制模块共用身份。
        if (typeof o._$uuid === "string") o._$uuid = uuid();
        for (const [k, v] of Object.entries(o)) if (k !== "$$hashKey") walk(v);
      }
      walk(root);
    };
    for (const entry of plan.sequence) {
      if (!entry || !Number.isInteger(entry.source) || entry.source < 0 || entry.source >= b.modules.length
          || !entry.edits || typeof entry.edits !== "object") fail("布局模块引用无效");
      const item = clone(b.modules[entry.source]);
      if (!item || typeof item !== "object" || !item._comp) fail("模板中存在不完整的顶层原生组件");
      const textStages = new Map();
      for (const [id, value] of Object.entries(entry.edits)) {
        const slot = slots.get(id);
        if (!slot || slot.module !== entry.source || !safeValue(value) || value.length > 50000) fail("文字或图片修改与模块不匹配");
        const cell = sourcePath(item, slot.path.slice(1));
        if (slot.kind === "text") {
          if (typeof cell.text !== "string" || !Number.isInteger(slot.run) || slot.run < 0) fail("不是原生文本框");
          const key = JSON.stringify(slot.path);
          if (!textStages.has(key)) textStages.set(key, { cell, edits: [] });
          textStages.get(key).edits.push({ slot, value });
        } else {
          if (typeof cell[slot.field] !== "string" || cell[slot.field] !== slot.original) fail("图片资源与原模板不符");
          const url = safeSrc(value); cell[slot.field] = url;
          if (!hosted(url)) { uploads.add(url); uploadUpdates.push({ cell, field: slot.field, url }); }
          changed.image++;
        }
      }
      for (const { cell, edits } of textStages.values()) {
        const { holder, root, out } = textRuns(cell.text);
        for (const { slot, value } of edits.sort((a, b) => b.slot.run - a.slot.run)) {
          if (slot.empty && !out.length && slot.run === 0) {
            const target = root.querySelector("p,span,section,div") || root;
            target.querySelector("br")?.remove(); target.append(document.createTextNode(value));
          } else {
            const node = out[slot.run];
            if (!node || node.nodeValue !== slot.original) fail("文字片段发生变化，无法保留行内样式");
            const split = value.replace(/\r\n?/g, "\n").split("\n");
            const frag = document.createDocumentFragment();
            split.forEach((s, i) => { if (i) frag.append(document.createElement("br")); frag.append(document.createTextNode(s)); });
            node.replaceWith(frag);
          }
          changed.text++;
        }
        cell.text = holder.innerHTML;
      }
      rekey(item); staged.push(item);
    }
    if (JSON.stringify(staged).length > 8_000_000) fail("生成后的原生组件超过 8MB，请减少模块或拆分批次");
    if (typeof manager.facility?.beforeInsertingComps !== "function") fail("当前秀米没有组件初始化接口，不能安全生成原生组件");
    const mapping = new Map();
    if (uploads.size) {
      // Upload embedded photos from the import file; users should not need to
      // upload their pictures to the Xiumi gallery manually.
      const transfer = injector.get("wxArticleTransfer");
      const imageHandler = injector.get("ossImageHandler");
      const embedded = [...uploads].filter((s) => s.startsWith("data:"));
      const external = [...uploads].filter((s) => !s.startsWith("data:"));
      const storageUrl = (value) => {
        const raw = typeof value === "string" ? value : value?.url || value?.uri || value?.target_uri || value?.src;
        if (typeof raw !== "string" || !raw) return "";
        let converted = raw;
        try { if (typeof imageHandler?.runtimeImageURI === "function") converted = imageHandler.runtimeImageURI(raw) || raw; } catch { converted = raw; }
        try {
          const url = new URL(converted, location.href);
          // Xiumi's image importer may use independent storage/CDN domains.
          // A returned HTTP(S) URL is enough; don't assume one fixed hostname.
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "";
          return url.href;
        } catch { return ""; }
      };
      const normalizeWebp = async (src) => {
        if (!/^data:image\/(webp|avif);base64,/i.test(src)) return src;
        // Xiumi's legacy base64 importer can reject WebP. Convert only those
        // formats to PNG locally, preserving the original import file.
        let bitmap;
        try {
          const blob = await (await fetch(src)).blob();
          bitmap = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("无法创建图像画布");
          ctx.drawImage(bitmap, 0, 0);
          return canvas.toDataURL("image/png");
        } catch (e) {
          throw new Error(`图片格式转换失败：${e.message || e}`);
        } finally { bitmap?.close?.(); }
      };
      for (const [items, method] of [[embedded, "fetchBase64ImgsToStorage"], [external, "fetchAnyImgsToStorage"]]) {
        if (!items.length) continue;
        if (typeof transfer?.[method] !== "function") fail("当前秀米版本不支持自动上传图片");
        const prepared = await Promise.all(items.map(normalizeWebp));
        const result = await transfer[method](prepared);
        for (let i = 0; i < items.length; i++) {
          const value = result?.[prepared[i]] ?? result?.[items[i]];
          const url = storageUrl(value);
          if (!url) fail(`第 ${i + 1}/${items.length} 张图片未获得秀米上传地址，正文尚未修改；已成功上传的图片可能留在素材库`);
          mapping.set(items[i], url);
        }
      }
      uploadUpdates.forEach((x) => { x.cell[x.field] = mapping.get(x.url); });
    }
    if (paperId() !== initialPaper || dialog() || pages.getActivePage()?.find(".tn-page-inst").compInst()?.comp !== pageInst.comp)
      fail("目标草稿已切换或弹出对话框，未写入内容");
    // 秀米可能在初始化原生组件时自动补充元信息，不额外设置内容一致性阻断。
    manager.facility.beforeInsertingComps(staged, "static", rootGroup.hostCompInst);
    if (paperId() !== initialPaper) fail("目标稿件已切换，未写入内容");
    const previous = [...model], previousStyle = clone(pageStyle);
    const styleNext = clone(b.pageStyle);
    for (const key of Object.keys(pageStyle)) if (!own(styleNext, key)) styleNext[key] = undefined;
    const rootScope = injector.get("$rootScope");
    const perform = () => {
      manager.beginBatch();
      let stage = 0;
      try {
        if (model.length) manager.remove(rootGroup.cellPath, model, 0, model.length);
        stage = 1;
        manager.insert(rootGroup.cellPath, model, staged); stage = 2;
        if (model.length !== staged.length) fail("秀米组件插入数量不符");
        manager.update(pageInst.compPath, pageStyle, styleNext); stage = 3;
      } catch (err) {
        try {
          if (stage >= 1) {
            if (model.length) manager.remove(rootGroup.cellPath, model, 0, model.length);
            if (previous.length) manager.insert(rootGroup.cellPath, model, previous);
          }
          manager.update(pageInst.compPath, pageStyle, previousStyle);
        } catch { throw new Error(`${err.message}。回滚未通过：请勿保存，刷新以恢复原来的空白草稿`); }
        throw new Error(`${err.message}。已恢复原草稿`);
      } finally { manager.endBatch(); }
    };
    await new Promise((resolve, reject) => {
      const run = () => { try { perform(); resolve(); } catch (e) { reject(e); } };
      if (rootScope.$$phase) rootScope.$evalAsync(run); else rootScope.$apply(run);
    });
    return { ok: true,
      message: `已导入 ${staged.length} 个原生模块（文字 ${changed.text} 处，图片 ${changed.image} 张），请在秀米检查排版。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "原生模板操作失败" };
  } finally { if (ownsLock) delete window[LOCK]; }
}
