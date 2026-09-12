/** A synthetic model adapter fixture, not an authenticated Xiumi draft.
 * @param {{html?:string[],failUpload?:boolean,failInsert?:boolean,pageStyle?:Record<string,string|number>}} options
 */
export function installXiumiModel({ html = [], failUpload = false, failInsert = false, pageStyle = {} } = {}) {
  const model = html.map((text) => ({ txt1: { type: "text", text } }));
  const root = document.querySelector(".tn-page-inst");
  const pin = root.querySelector(".tn-comp-style-pin");
  const instances = new WeakMap();
  const calls = [];
  const page = { compPath: "page", comp: { _comp: { style: { ...pageStyle } } } };
  const container = { cellPath: "page.comps", cellArray: model, hostCompInst: page };
  const render = () => {
    pin.replaceChildren();
    model.forEach((comp, index) => {
      const node = document.createElement("section"); node.className = "tn-comp-top-level";
      const cell = document.createElement("div"); cell.contentEditable = "true"; cell.innerHTML = comp.txt1.text;
      instances.set(cell, { cellPath: `page.comps:${index}.txt1`, cell: comp.txt1 });
      node.append(cell); pin.append(node);
    });
  };
  const slot = { cellInst: () => container };
  const wrapper = { 0: root, compInst: () => page, find: () => slot };
  const active = { find: () => wrapper };
  const manager = {
    config: () => "paper", beginBatch: () => calls.push("begin"), endBatch: () => calls.push("end"),
    update: (_path, object, props) => { Object.assign(object, props); calls.push("update"); },
    insert: (_path, array, items) => { calls.push("insert"); array.push(...items); if (failInsert) throw new Error("simulated insert failure"); },
    remove: (_path, array, start, count) => array.splice(start, count),
    facility: { createDefaultComp: (_type, _role, args) => ({ txt1: { type: "text", text: args.text } }), beforeInsertingComps: () => calls.push("prepare") },
  };
  const upload = async (sources) => { calls.push(`upload:${sources.length}`); return failUpload ? {} : Object.fromEntries(sources.map((source, index) => [source, `https://statics.xiumi.us/mock/image-${index}.png`])); };
  const services = {
    tower: { require: () => manager }, tnScrolledPageManager: { getActivePage: () => active },
    $rootScope: { $apply: (work) => { const result = work(); render(); return result; } },
    wxArticleTransfer: { fetchBase64ImgsToStorage: upload, fetchAnyImgsToStorage: upload }, ossImageHandler: { runtimeImageURI: (source) => source },
  };
  window.angular = { element: () => ({ injector: () => ({ get: (name) => services[name] }) }) };
  window.jQuery = (element) => ({ cellInst: () => instances.get(element) });
  window.xiumiModel = { model, page, calls, render };
  render();
}
