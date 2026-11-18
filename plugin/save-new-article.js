/**
 * Save a NEW, already-populated Xiumi v5 paper using its Angular controller.
 * Does not synthesize clicks or construct guessed HTTP request signatures.
 * Xiumi handles authentication, signing and creation through its own save path.
 */
export async function saveNewArticleInPage() {
  try {
    if (location.hostname !== 'xiumi.us' || !location.hash.startsWith('#/paper/'))
      throw new Error('请打开秀米图文编辑器');
    const currentId = () => location.hash.match(/\/paper\/for\/(\d+)/)?.[1] || '';
    if (currentId()) return { ok: true, paperId: currentId(), alreadySaved: true };
    const ng = window.angular;
    if (!ng || typeof ng.element !== 'function') throw new Error('秀米 Angular 编辑器未初始化');
    const root = ng.element(document.body).injector() || ng.element(document.documentElement).injector();
    if (!root) throw new Error('无法获取秀米编辑器服务');
    const pages = root.get('tnScrolledPageManager');
    const paperPage = pages.getActivePage()?.find('.tn-page-inst');
    const cells = paperPage?.find('.tn-comp-slot').cellInst()?.cellArray;
    if (!Array.isArray(cells) || !cells.length) throw new Error('正文尚未写入，不能创建空稿件');

    // The internal save controller is the same one bound to Xiumi's own toolbar.
    // Resolve the known method by inspecting Angular scopes; no DOM button click.
    const found = new Set();
    const candidates = [document.body, document.documentElement];
    for (const selector of [
      '[ng-click*="onBtnClickSave"]',
      '[data-ng-click*="onBtnClickSave"]',
      '[x-ng-click*="onBtnClickSave"]',
    ]) for (const el of document.querySelectorAll(selector)) candidates.push(el);
    // Scope boundaries may live on parents of the toolbar element.
    for (const el of [...candidates]) {
      for (let parent = el?.parentElement, count = 0; parent && count < 7; parent = parent.parentElement, count++)
        candidates.push(parent);
    }
    const ownerWithSave = (scope) => {
      for (let s = scope, depth = 0; s && depth < 20; s = s.$parent, depth++) {
        if (found.has(s)) continue;
        found.add(s);
        for (const owner of [s, s.vm, s.$ctrl, s.ctrl, s.controller, s.editor, s.paper, s.show]) {
          if (owner && typeof owner.onBtnClickSave === 'function')
            return { owner, fn: owner.onBtnClickSave };
        }
      }
      return null;
    };
    let handler = null;
    for (const el of candidates) {
      let wrapped;
      try { wrapped = ng.element(el); } catch { continue; }
      for (const s of [wrapped?.scope?.(), wrapped?.isolateScope?.()]) {
        if ((handler = ownerWithSave(s))) break;
      }
      if (handler) break;
    }
    if (!handler) throw new Error('当前秀米版本未暴露 onBtnClickSave 保存方法');
    const rootScope = root.get('$rootScope');
    await new Promise((resolve, reject) => {
      const call = () => {
        try { Promise.resolve(handler.fn.call(handler.owner)).then(resolve, reject); }
        catch (err) { reject(err); }
      };
      if (rootScope.$$phase) rootScope.$evalAsync(call);
      else rootScope.$apply(call);
    });
    // Saving a newly created article gives it a new paper ID. Do not report
    // success merely because the save handler returned or a toast was shown.
    for (let attempt = 0; attempt < 60 && !currentId(); attempt++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const id = currentId();
    if (!id) throw new Error('已调用秀米内部保存函数，但未取得新稿件 ID（可能需要登录或秀米拒绝保存）');
    return { ok: true, paperId: id };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
