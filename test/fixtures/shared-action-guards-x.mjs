// Owned correction fixture derived from the installed DraftJS quality app.
// Actual React/DraftJS state owns editor mutations; deletion uses an intercepted
// local UI receipt. No production guard or account action is substituted.
export function sharedGuardXHtml({draftCss,libraryFiles,account}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Owned home timeline</title>
<style>${draftCss}
body{margin:0;background:#fff;color:#111;font:17px system-ui}#app{display:flex;gap:24px;margin:20px}
#account-nav{width:170px}a{color:inherit}main{width:660px}.tabs{height:55px;display:flex;gap:20px}
#inline-owner{padding:16px;border:1px solid #bbb;display:flex;gap:15px;min-height:230px;box-sizing:border-box}
.avatar{width:45px;height:45px;display:block;border-radius:50%;background:#456;color:white;text-align:center;line-height:45px}
.compose-inner{width:560px}.public-DraftEditor-content{height:100px;overflow:auto}.DraftEditor-root{height:100px}
button{font:inherit;padding:8px;margin:3px}.compose-actions{display:flex;align-items:center;justify-content:space-between}
article{padding:16px;border:1px solid #ddd;height:120px}#confirmation{padding:12px}
[data-testid="tweetText"]{white-space:pre-wrap}</style>
${libraryFiles.map(([name]) => `<script src="/owned-fixture/${name}"></script>`).join('')}
</head><body><div id="app"></div><script>
window.qaEvents=[];window.qaCommands=[];window.qaFeedChanges=0;window.qaSaved=window.qaInitialSaved?[window.qaInitialSaved]:[];window.qaDeleted=[];window.qaMenuClicks=0;
window.qaToolbarActions={delete:0,save:0};window.qaUnrelatedDeletes=0;
window.qaExpandOnFocus=!!window.qaExpandOnFocus;
const root=ReactDOM.createRoot(document.querySelector('#app'));
function App(){
  const [editorState,setEditorState]=React.useState(()=>window.qaInitialDraft
    ?Draft.EditorState.createWithContent(Draft.ContentState.createFromText(window.qaInitialDraft))
    :Draft.EditorState.createEmpty());
  const [identity,setIdentity]=React.useState('${account}');
  const [audience,setAudience]=React.useState(window.qaExpandOnFocus?null:'Everyone can reply');
  const [ownerVersion,setOwnerVersion]=React.useState(0);
  const [mediaLabel,setMediaLabel]=React.useState('Add photos or video');
  const [feedRevision,setFeedRevision]=React.useState(0);
  const [saved,setSaved]=React.useState(window.qaInitialSaved||null);const [menuOpen,setMenuOpen]=React.useState(false);window.qaCurrentSaved=saved;
  window.qaAlterSaved=change=>ReactDOM.flushSync(()=>setSaved(value=>({...value,...change})));
  window.qaVirtualizeSaved=()=>ReactDOM.flushSync(()=>setSaved(null));
 const deletePost=async()=>{const response=await fetch('/owned-fixture/post/'+saved.id,{method:'DELETE'});if(response.ok){qaDeleted.push(saved);setSaved(null);setMenuOpen(false);}};
  window.qaEditorState=editorState;
  window.qaChangeContext=kind=>ReactDOM.flushSync(()=>{
    if(kind==='owner')setOwnerVersion(value=>value+1);
    if(kind==='account')setIdentity('otherqa');
    if(kind==='audience')setAudience('Only people you mention can reply');
    if(kind==='navigation')setMediaLabel('Add private attachment');
  });
  window.qaChurnFeed=()=>ReactDOM.flushSync(()=>{window.qaFeedChanges++;setFeedRevision(value=>value+1);});
  const onChange=next=>{window.qaEditorState=next;setEditorState(next);};
  const value=editorState.getCurrentContent().getPlainText('\\n');
  const post=async()=>{
    const payload={account:identity,body:editorState.getCurrentContent().getPlainText('\\n'),audience,id:String(900+qaSaved.length)};
    const response=await fetch('/owned-fixture/post',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(response.ok){window.qaSaved.push(payload);setSaved(payload);setEditorState(window.qaAfterPublishSuggestion
      ?Draft.EditorState.createWithContent(Draft.ContentState.createFromText(window.qaAfterPublishSuggestion)):Draft.EditorState.createEmpty());}
  };
  return React.createElement(React.Fragment,null,
    React.createElement('nav',{id:'account-nav','aria-label':'Account navigation'},
      React.createElement('a',{'data-testid':'AppTabBar_Profile_Link',href:'/'+identity},'Owned QA profile')),
    React.createElement('main',{'aria-label':'Home timeline'},
      React.createElement('nav',{className:'tabs','aria-label':'Home timeline tabs'},
        React.createElement('button',{type:'button',role:'tab','aria-selected':'true'},'For you'),
        React.createElement('button',{type:'button',role:'tab','aria-selected':'false'},'Following')),
      React.createElement('div',{id:'inline-owner',key:ownerVersion,role:window.qaModal&&!saved?'dialog':undefined},
        React.createElement('a',{className:'avatar',href:'/'+identity,'aria-label':'Owned QA account avatar'},'QA'),
        React.createElement('div',{className:'compose-inner',onFocus:()=>{if(window.qaExpandOnFocus&&!audience)ReactDOM.flushSync(()=>setAudience('Everyone can reply'));}},
          React.createElement(Draft.Editor,{editorState,onChange,ariaLabel:'Post text',webDriverTestID:'tweetTextarea_0',placeholder:'What is happening?!'}),
          audience?React.createElement('button',{id:'audience',type:'button'},audience):null,
          React.createElement('div',{className:'compose-actions'},
            React.createElement('nav',{'aria-label':'Composer tools'},
              React.createElement('button',{type:'button','aria-label':mediaLabel},'Media'),
              React.createElement('button',{type:'button','aria-label':'Add emoji'},'Emoji')),
            React.createElement('button',{id:'post',type:'button','data-testid':'tweetButtonInline',disabled:!value,onClick:post},'Post')))),
      React.createElement('div',{id:'confirmation',role:'status'},saved?'Owned local QA post recorded: '+saved.body:''),
      saved?React.createElement('article',{'data-testid':'tweet',role:'article','data-post-id':saved.id},React.createElement('h2',null,'Owned published QA post'),
        React.createElement('div',{'data-testid':'User-Name'},
          React.createElement('a',{href:'/'+saved.account},'Owned QA account'),
          React.createElement('a',{href:'/'+saved.account+'/status/'+saved.id},React.createElement('time',{dateTime:new Date().toISOString()},'Now'))),
        React.createElement('div',{'data-testid':'tweetText'},saved.body),
 React.createElement('button',{id:'post-menu',type:'button','aria-label':'Post actions','aria-haspopup':'menu','aria-expanded':String(menuOpen),'aria-controls':'post-options',onClick:()=>{qaMenuClicks++;setMenuOpen(true);}},'More'),
 menuOpen?(window.qaPortalMenu?ReactDOM.createPortal(
   React.createElement('div',{id:'post-options',role:'menu','aria-labelledby':'post-menu','data-state':'open'},React.createElement('button',{id:'delete-post',role:'menuitem',type:'button',onClick:deletePost},'Delete')),document.body)
   :React.createElement('div',{id:'post-options',role:'menu'},React.createElement('button',{id:'delete-post',role:'menuitem',type:'button',onClick:deletePost},'Delete'))):null):null,
      window.qaUnrelatedRecord?React.createElement('article',{id:'unrelated-record',role:'article','data-record':'B'},
        React.createElement('h2',null,'Unrelated record B'),React.createElement('p',null,'Keep unrelated record B intact.'),
        React.createElement('button',{id:'delete-unrelated',role:'menuitem',type:'button',onClick:()=>{qaUnrelatedDeletes++;fetch('/owned-fixture/post/unrelatedb',{method:'DELETE'});}},'Delete unrelated record')):null,
      window.qaDangerToolbar?React.createElement('section',{'aria-label':'Owned local draft editor'},React.createElement('h2',null,'Owned local draft editor'),
        React.createElement('form',{id:'local-draft-form',method:'post',action:'/owned-fixture/local-save',onSubmit:event=>event.preventDefault()},
          React.createElement('div',{id:'local-draft-editor',role:'textbox',contentEditable:true,suppressContentEditableWarning:true,'aria-label':'Local draft'},'Keep local draft intact.'),
          React.createElement('div',{role:'toolbar','aria-controls':'local-draft-editor'},React.createElement('button',{id:'danger-toolbar',type:'button',title:window.qaToolbarTitle?(window.qaDangerToolbar==='delete'?'Delete record':'Save record'):undefined,onClick:()=>{
            qaToolbarActions[window.qaDangerToolbar]++;fetch('/owned-fixture/toolbar-'+window.qaDangerToolbar,{method:'POST'});
          }},window.qaToolbarTitle?'Bold':window.qaDangerToolbar==='delete'?'Delete record':'Save')))):null,
      window.qaTallFeed?React.createElement('div',{id:'feed',role:'feed','aria-label':'Owned QA tall timeline',...(window.qaVirtualized?{'aria-setsize':'100'}:{})},
        [...Array(12)].map((_value,index)=>React.createElement('article',{key:feedRevision+'-'+index},
          React.createElement('a',{href:'/feedqa/status/'+(feedRevision*100+index)},'Unrelated feed account'),
          React.createElement('p',null,'Live unrelated feed record '+feedRevision+'-'+index),
          React.createElement('button',{type:'button','aria-label':'Like feed item '+index},'Like'))))
        :React.createElement('div',{id:'feed'},React.createElement('p',null,'Owned complete local collection, revision '+feedRevision))));
}
ReactDOM.flushSync(()=>root.render(React.createElement(App)));
window.qaPreparationOverlays=0;
window.qaArmPreparationOverlay=()=>document.querySelector('#post').addEventListener('pointerenter',event=>{
  if(!event.isTrusted)return;
  const rect=event.currentTarget.getBoundingClientRect(),overlay=document.createElement('button');
  overlay.id='qa-native-preparation-overlay';overlay.type='button';overlay.textContent='Owned temporary preparation overlay';
  overlay.style='position:fixed;z-index:100000;left:'+(rect.left-1)+'px;top:'+(rect.top-1)+'px;width:'+(rect.width+2)+'px;height:'+(rect.height+2)+'px';
  document.body.append(overlay);window.qaPreparationOverlays++;
},{once:true});
window.qaClearPreparationOverlay=()=>document.getElementById('qa-native-preparation-overlay')?.remove();
if(window.qaPartialSelection)document.querySelector('[data-testid="tweetTextarea_0"]').addEventListener('keydown',event=>{
  if(event.isTrusted&&event.code==='KeyA'&&(event.ctrlKey||event.metaKey))event.preventDefault();
},true);
for(const type of ['beforeinput','input','paste'])document.querySelector('#app').addEventListener(type,event=>{
  if(event.target.closest('[data-testid="tweetTextarea_0"]'))qaEvents.push({type,trusted:event.isTrusted,inputType:event.inputType,
    data:type==='paste'?event.clipboardData?.getData('text/plain'):event.data});
},true);
const execCommand=document.execCommand.bind(document);
document.execCommand=(command,showUI,value)=>{qaCommands.push({command,value});return execCommand(command,showUI,value);};
window.qaSnapshot=()=>{
  const editor=document.querySelector('[data-testid="tweetTextarea_0"]');
  return {model:qaEditorState.getCurrentContent().getPlainText('\\n'),modelBlocks:qaEditorState.getCurrentContent().getBlocksAsArray().map(block=>block.getText()),
    text:editor.textContent,blocks:[...editor.querySelectorAll('[data-block="true"]')].map(block=>block.textContent),
    postEnabled:!document.querySelector('#post').disabled,audience:document.querySelector('#audience')?.textContent||null,
    events:qaEvents,commands:qaCommands,feedChanges:qaFeedChanges,saved:qaSaved,deleted:qaDeleted,menuClicks:qaMenuClicks,current:qaCurrentSaved,
    toolbarActions:qaToolbarActions,unrelatedDeletes:qaUnrelatedDeletes,portalMenuOpen:!!document.querySelector('body > #post-options')};
};
</script></body></html>`;
}
