/** Import previously generated HTML packets as simple text modules. */
export async function applyBridgeInPage(packet) {
  try {
    const fail = (message) => { throw new Error(message); };
    const visible = (element) => element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== "hidden";
    if (location.hostname !== "xiumi.us" || !location.hash.startsWith("#/paper/")) fail("请打开秀米图文编辑页");
    if ([...document.querySelectorAll('.modal,[role="dialog"]')].some(visible)) fail("请先处理秀米当前的对话框，再执行导入；原有草稿缓存会保留");
    const angular = window.angular; const $ = window.jQuery || window.$;
    const injector = angular?.element(document.body).injector() || angular?.element(document.documentElement).injector();
    if (!injector || typeof $ !== "function") fail("未找到秀米编辑服务，请等待页面加载完成");
    const tower = injector.get("tower");
    const manager = tower.require("editingManager");
    const pages = injector.get("tnScrolledPageManager");
    const activePage = pages.getActivePage();
    const pageElement = activePage?.find(".tn-page-inst");
    const pageInstance = pageElement?.compInst();
    const container = pageElement?.find(".tn-comp-slot").cellInst();
    const facility = manager?.facility;
    if (!pageInstance || !Array.isArray(container?.cellArray) || !facility || manager.config("showType") !== "paper" || !["beginBatch", "endBatch", "update", "insert", "remove"].every((name) => typeof manager[name] === "function")) fail("当前秀米版本没有兼容的模块写入通道，未更改正文");
    const pageRoot = pageElement[0];
    const paperId = () => location.hash.match(/\/paper\/for\/(\d+)/)?.[1] || null;
    const initialPaperId = paperId();
    const parse = (html) => { const holder = document.createElement("template"); holder.innerHTML = html; return holder; };
    const textCells = (comp) => {
      const cells = [];
      const visit = (value) => {
        if (!value || typeof value !== "object") return;
        if (value.type === "text" && typeof value.text === "string") { cells.push(value); return; }
        for (const [key, child] of Object.entries(value)) if (key !== "_comp") visit(child);
      };
      visit(comp); return cells;
    };
    if (packet?.nativeEdit) fail("这是原生修改包，请点击原生更新；不能作为 HTML 导入");
    if (typeof packet?.html !== "string" || !packet.html.trim()) fail("数据包没有正文");
    const scope = injector.get("$rootScope");
    const transact = async (work) => new Promise((resolve, reject) => {
      const run = () => { manager.beginBatch(); try { resolve(work()); } catch (error) { reject(error); } finally { manager.endBatch(); } };
      if (scope.$$phase) scope.$evalAsync(run); else scope.$apply(run);
    });
    const validLink = (value) => { if (!value) return ""; const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) fail("链接地址无效"); return url.href; };
    if (container.cellArray.length) fail("分模块导入需要空白秀米图文。请新建图文后导入；请先新建空白草稿");
    if (typeof facility.createDefaultComp !== "function" || typeof facility.beforeInsertingComps !== "function") fail("秀米原生组件工厂不可用，未写入正文");
    const native = packet.native;
    if (!Array.isArray(native?.modules) || !native.modules.length || native.modules.length > 5000) fail("缺少可导入的模块边界，请用新版 OpsLion 重新导出 Bridge 数据包");
    const allowedStyles = new Set(["font-family", "font-size", "line-height", "letter-spacing", "color", "text-align", "text-indent", "padding-top", "padding-right", "padding-bottom", "padding-left", "background-color", "background-image", "background-size", "background-position", "background-repeat"]);
    const format = document.createElement("section");
    for (const [key, value] of Object.entries(native.pageFormat?.styles || {})) { if (!allowedStyles.has(key) || typeof value !== "string") fail("全文格式包含未知设置"); format.style.setProperty(key, value); if (!format.style.getPropertyValue(key)) fail("全文格式无效"); }
    const holders = native.modules.map((module) => { if (typeof module.html !== "string" || !module.html.trim()) fail("存在空模块"); return parse(module.html); });
    const manifest = new Map((packet.assets || []).map((asset) => [asset.id, asset.src]));
    const sources = new Set(); const rewrites = [];
    const resource = (value) => {
      if (value.startsWith("#")) return value;
      if (value.startsWith("opslion-asset://")) { value = manifest.get(value.slice(16)); if (!value) fail("素材清单缺少图片"); }
      if (!/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(value)) {
        let url; try { url = new URL(value); } catch { fail("包含本地图片地址，请在 OpsLion 重新导出并绑定素材"); }
        if (!["https:", "http:"].includes(url.protocol) || /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) fail("图片尚未绑定为可发布资源");
      }
      sources.add(value); return value;
    };
    for (const holder of [...holders, { content: format }]) for (const element of [holder.content, ...holder.content.querySelectorAll("*")]) {
      if (!(element instanceof Element)) continue;
      if (/^(SCRIPT|IFRAME|OBJECT|EMBED|FORM|INPUT|BUTTON|STYLE|LINK|META)$/i.test(element.tagName)) fail("模块包含不支持的活动内容");
      for (const attribute of element.attributes) {
        if (/^on/i.test(attribute.name)) fail("模块包含脚本事件，未导入");
        if (["href", "xlink:href"].includes(attribute.name) && element.localName === "a") validLink(attribute.value);
      }
      if (["animate", "animateTransform", "set"].includes(element.localName) && !/^(?:viewBox|height|width|x|y|opacity|transform|visibility)$/.test(element.getAttribute("attributeName") || "")) fail("SVG 动画尝试修改不支持的属性");
      for (const name of element.tagName === "IMG" ? ["src"] : element.localName === "image" ? ["href", "xlink:href"] : []) {
        const raw = element.getAttribute(name); if (!raw) continue;
        const src = resource(raw); rewrites.push((mapping) => element.setAttribute(name, mapping.get(src) || src));
      }
      if (element.localName === "use" && !/^#/.test(element.getAttribute("href") || element.getAttribute("xlink:href") || "")) fail("SVG 外部引用不受支持");
      if (element.hasAttribute("style")) {
        const style = element.getAttribute("style");
        if (/[\\]|\/\*|(?:expression|var|attr|env|image-set)\s*\(|(?:javascript|vbscript)\s*:/i.test(style)) fail("模块包含不支持的样式");
        const found = [...style.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi)].map((match) => ({ match: match[0], src: resource(match[2]) }));
        rewrites.push((mapping) => { let next = style; for (const item of found) next = next.replaceAll(item.match, `url("${(mapping.get(item.src) || item.src).replace(/"/g, "%22")}")`); element.setAttribute("style", next); });
      }
    }
    const transfer = injector.get("wxArticleTransfer"); const images = injector.get("ossImageHandler");
    const embedded = [...sources].filter((src) => src.startsWith("data:"));
    const isHosted = (src) => { try { const host = new URL(src).hostname; return /(^|\.)xiumi\.us$/.test(host) || /(^|\.)xiumius\.cn$/.test(host); } catch { return false; } };
    const external = [...sources].filter((src) => !src.startsWith("data:") && !src.startsWith("#") && !isHosted(src));
    if ((embedded.length && typeof transfer.fetchBase64ImgsToStorage !== "function") || (external.length && typeof transfer.fetchAnyImgsToStorage !== "function") || typeof images.runtimeImageURI !== "function") fail("当前秀米版本不支持所需的素材上传，请先在秀米上传并绑定图片");
    const mapping = new Map();
    // Upload before touching article data. Xiumi's importer can return partial
    // success, so every resource must have a real hosted address before commit.
    for (const [list, method] of [[embedded, "fetchBase64ImgsToStorage"], [external, "fetchAnyImgsToStorage"]]) {
      if (!list.length) continue;
      const result = await transfer[method](list);
      for (const src of list) {
        const hosted = result?.[src] && new URL(images.runtimeImageURI(result[src]), location.href).href;
        if (!hosted || !isHosted(hosted)) fail("部分图片上传失败，正文尚未写入。请检查素材后重试");
        mapping.set(src, hosted);
      }
    }
    for (const rewrite of rewrites) rewrite(mapping);
    const comps = holders.flatMap((holder) => {
      const created = facility.createDefaultComp("paper", "text", { text: holder.innerHTML });
      const result = Array.isArray(created) ? created : [created];
      if (result.length !== 1 || !result[0] || textCells(result[0]).length !== 1 || textCells(result[0])[0].text !== holder.innerHTML) fail("秀米组件工厂没有保留模块内容，未写入正文");
      return result;
    });
    if (JSON.stringify(comps).length > 1_500_000 || /data:image\//i.test(JSON.stringify(comps))) fail("模块数据仍然过大或存在内嵌图片，未写入正文");
    const style = pageInstance.comp?._comp?.style;
    if (!style || typeof style !== "object") fail("无法定位全文格式，未写入正文");
    const previousStyle = { ...style };
    const nextStyle = { compMargin: 0, paragraphMargin: 0, textIndent: "0px", textAlign: "left", letterSpacing: "normal", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px", backgroundColor: "transparent", backgroundImage: "none", backgroundSize: "auto", backgroundPosition: "0% 0%", backgroundRepeat: "repeat" };
    for (const property of allowedStyles) {
      const value = format.style.getPropertyValue(property); if (value) nextStyle[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    }
    const fontSize = parseFloat(format.style.fontSize);
    if (format.style.lineHeight.endsWith("px") && fontSize > 0) nextStyle.lineHeight = String(parseFloat(format.style.lineHeight) / fontSize);
    if (format.style.fontSize.endsWith("px")) {
      const base = parseFloat(getComputedStyle(pageRoot).fontSize);
      if (base > 0) nextStyle.fontSize = `${fontSize / base * 100}%`;
    }
    // A user may edit while uploads are running. Recheck immediately before commit.
    if (container.cellArray.length || paperId() !== initialPaperId || pageInstance.comp !== pages.getActivePage()?.find(".tn-page-inst").compInst()?.comp || [...document.querySelectorAll('.modal,[role="dialog"]')].some(visible)) fail("上传期间稿件状态已改变，请重新打开插件后导入");
    facility.beforeInsertingComps(comps, "static", container.hostCompInst);
    if (comps.some((comp, index) => textCells(comp).length !== 1 || textCells(comp)[0].text !== holders[index].innerHTML)) fail("秀米的模块准备流程改变了母版内容，未写入正文");
    await transact(() => {
      try {
        manager.update(pageInstance.compPath, style, nextStyle);
        if (Object.entries(nextStyle).some(([key, value]) => style[key] !== value)) fail("全文格式未完整写入");
        manager.insert(container.cellPath, container.cellArray, comps);
        if (container.cellArray.length !== comps.length) fail("模块写入数量不符");
      } catch (error) {
        if (container.cellArray.length) manager.remove(container.cellPath, container.cellArray, 0, container.cellArray.length);
        manager.update(pageInstance.compPath, style, Object.fromEntries([...new Set([...Object.keys(nextStyle), ...Object.keys(previousStyle)])].map((key) => [key, previousStyle[key]])));
        throw error;
      }
    });
    return { ok: true, message: `已导入 ${comps.length} 个 HTML 模块和 ${mapping.size} 张图片，请在秀米保存。` };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : "秀米导入未完成" }; }
}
