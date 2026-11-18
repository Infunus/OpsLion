// Only extension-owned pages can request opening the collector. No website messaging API.
let opening;
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if(sender.id!==chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')) || message?.action!=='open-collector')return;
  opening ||= (async()=>{
    const url=chrome.runtime.getURL('collector.html');
    const contexts=await chrome.runtime.getContexts({contextTypes:['TAB'],documentUrls:[url]});const existing=contexts[0];
    if(existing) {await chrome.tabs.update(existing.tabId,{active:true});await chrome.windows.update(existing.windowId,{focused:true});}
    else await chrome.tabs.create({url});
  })().finally(()=>{opening=null;});
  void opening.then(()=>reply({ok:true}),error=>reply({ok:false,message:error.message}));
  return true;
});
