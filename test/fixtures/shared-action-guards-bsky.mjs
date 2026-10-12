// The bundled source-backed ProseMirror model/view owns all text changes.
// Native visible controls produce only intercepted local receipts.
export function sharedGuardBskyHtml({ account, originalId = '3ownedqa' }) {
  return `<!doctype html><meta charset="utf-8"><title>Owned Bluesky correction fixture</title>
<style>body{font:18px system-ui;margin:20px}#composer{width:650px;padding:18px;border:1px solid #888}.ProseMirror{min-height:120px;white-space:pre-wrap;border:1px solid #888}.ProseMirror p{margin:0}button,[role=button]{padding:10px;margin:6px;cursor:pointer}article{padding:12px;border:1px solid #bbb;width:620px}</style>
<script src="/owned-fixture/editor.js"></script><nav aria-label="Account navigation"><a href="/profile/${account}">Owned profile</a></nav>
<section aria-label="Owned composer navigation"><h2>Owned composer navigation</h2><button id="compose" type="button" aria-label="Compose new post" hidden>Compose</button></section><main id="timeline"></main>
<div role="dialog" aria-modal="true" id="composer"><div data-testid="composePostView"><div id="topbar"><div role="button" tabindex="0" aria-label="Cancel">Cancel</div>
<div id="publish" role="button" tabindex="0" aria-label="Publish post" aria-disabled="true" data-testid="composerPublishBtn">Post</div></div>
<div id="editor-row"><div data-testid="userAvatarImage"><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='30' height='30'%3E%3Crect width='30' height='30' fill='%238ac'/%3E%3C/svg%3E"></div><div id="editor-host"></div></div>
<div id="footer"><div role="button" tabindex="0" aria-label="Anyone can interact" data-testid="openReplyGateButton">Anyone can interact</div><div role="button" tabindex="0" aria-label="Add image">Add image</div></div></div></div>
<script>
window.qaEvents=[];window.qaSaved=[];window.qaDeleted=[];window.qaMenuClicks=0;window.qaCurrentSaved=null;
qaEditorLibrary.mountEditor('');
for(const type of ['beforeinput','input','paste'])document.querySelector('#editor-host').addEventListener(type,event=>qaEvents.push({type,trusted:event.isTrusted,data:event.data}),true);
document.querySelector('#compose').onclick=()=>{document.querySelector('#composer').hidden=false;document.querySelector('#compose').hidden=true;qaEditorLibrary.mountEditor('');};
document.querySelector('#publish').onclick=async()=>{
 if(document.querySelector('#publish').getAttribute('aria-disabled')==='true')return;
 const payload={account:'${account}',body:qaSnapshotEditor().model,id:qaSaved.length?'3ownedqb':'${originalId}'};
 const response=await fetch('/owned-fixture/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
 if(!response.ok)return;qaSaved.push(payload);qaCurrentSaved=payload;document.querySelector('#composer').hidden=true;document.querySelector('#compose').hidden=false;
 qaEditorLibrary.mountEditor('');
 const card=document.createElement('article');card.id='saved-record';card.dataset.testid='feedItem-by-${account}';card.dataset.postId=payload.id;
 const heading=document.createElement('h2');heading.textContent='Owned published QA post';card.append(heading);
 const author=document.createElement('a');author.href='/profile/'+payload.account;author.textContent='Owned QA @'+payload.account;card.append(author);
 const permalink=document.createElement('a');permalink.href='/profile/'+payload.account+'/post/'+payload.id;permalink.rel='bookmark';permalink.textContent='Now';card.append(permalink);
 const body=document.createElement('div');body.dataset.wordWrap='1';body.dir='auto';body.textContent=payload.body;card.append(body);
 const more=document.createElement('button');more.id='post-menu';more.type='button';more.setAttribute('aria-label','Post actions');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.setAttribute('aria-controls','post-options');more.textContent='More';
 more.onclick=()=>{qaMenuClicks++;more.setAttribute('aria-expanded','true');const menu=document.createElement('div');menu.id='post-options';menu.setAttribute('role','menu');
  const remove=document.createElement('button');remove.id='delete-post';remove.type='button';remove.setAttribute('role','menuitem');remove.textContent='Delete';
  remove.onclick=async()=>{const result=await fetch('/owned-fixture/post/'+payload.id,{method:'DELETE'});if(result.ok){qaDeleted.push(payload);qaCurrentSaved=null;card.remove();}};
  menu.append(remove);card.append(menu);};card.append(more);document.querySelector('#timeline').append(card);
};
window.qaSnapshot=()=>({...qaSnapshotEditor(),events:qaEvents,saved:qaSaved,deleted:qaDeleted,current:qaCurrentSaved,menuClicks:qaMenuClicks,dialogOpen:!document.querySelector('#composer').hidden});
</script>`;
}
