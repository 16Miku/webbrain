export const uploadReleaseHtml = `<!doctype html><meta charset="utf-8"><title>Owned release upload fixture</title>
<style>body{margin:20px;font:16px sans-serif}main{width:780px}button,label{display:block;margin:12px 0}
.file-transport{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden}.file-transport input{width:1px;height:1px;opacity:0}
file-attachment{display:block;border:1px solid #888;padding:12px;margin:12px 0}#clock{position:absolute;left:850px;top:20px}</style>
<main data-repository="owned/repository"><h1>New release for owned/repository</h1>
<form id="release-form" action="/owned/repository/releases" method="post"><h2>Release title</h2>
<label for="release-title">Release title</label><input id="release-title" name="release[name]" value="Owned release">
<h2>Release notes</h2><label for="release-body">Release description</label><textarea id="release-body" name="release[body]">Owned notes</textarea>
<file-attachment id="markdown-widget"><button id="markdown-button" type="button">Paste, drop, or click to add files</button>
<div class="file-transport"><input id="fc-release-body" type="file" accept="image/*" multiple></div></file-attachment>
<file-attachment id="binary-widget"><button id="binary-button" type="button">Attach binaries by dropping them here or selecting them.</button>
<div class="file-transport"><input id="releases-upload" type="file" multiple></div><p id="binary-status" role="status">No binary attached</p></file-attachment>
<button type="submit">Publish release</button></form></main><aside id="clock">1</aside><button id="human">Human control</button>
<script>window.attachmentEvents={markdown:[],binary:[]};window.chooserClicks=0;
for(const [slot,id] of [['markdown','fc-release-body'],['binary','releases-upload']])document.getElementById(id).addEventListener('change',event=>{
 attachmentEvents[slot].push([...event.target.files].map(file=>({name:file.name,size:file.size})));
 if(slot==='binary')document.getElementById('binary-status').textContent='Binary staged: '+[...event.target.files].map(file=>file.name).join(', ');
});document.getElementById('binary-button').onclick=()=>{chooserClicks++;document.getElementById('releases-upload').click();};
document.getElementById('release-form').onsubmit=event=>event.preventDefault();</script>`;

// Trace e6187b5f (WebBrain 42.3.1, x.com/compose/post): X opens the post
// composer as a dialog over the home timeline, and the timeline's inline
// composer keeps its own hidden input[data-testid="fileInput"]. The two share
// accept, multiple and their ten nearest ancestors; only the dialog differs.
// The toolbar skeleton is X's own as of 2026-10 (text and icons omitted).
const xComposerToolbar = `<nav role="navigation"><div>
<div data-testid="ScrollSnap-prevButtonWrapper" style="opacity:0"><button type="button" aria-label="Previous" disabled tabindex="-1"><span>&lt;</span></button></div>
<div data-testid="ScrollSnap-SwipeableList"><div role="tablist" data-testid="ScrollSnap-List">
<div role="presentation"><div><div><div>
<button type="button" role="button" aria-label="Add photos or video"><span>Media</span></button>
<input type="file" data-testid="fileInput" tabindex="-1" multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime">
</div></div></div></div>
<div role="presentation"><div><div><button type="button" role="button" data-testid="gifSearchButton" aria-label="Add a GIF"><span>GIF</span></button></div></div></div>
<div role="presentation"><div><div><button type="button" role="button" data-testid="createPollButton" aria-label="Add poll"><span>Poll</span></button></div></div></div>
<div role="presentation"><div><div><div><button type="button" role="button" aria-label="Add emoji"><span>Emoji</span></button></div></div></div></div>
</div></div>
<div data-testid="ScrollSnap-nextButtonWrapper" style="opacity:0"><button type="button" aria-label="Next" disabled tabindex="-1"><span>&gt;</span></button></div>
</div></nav>`;
const xComposer = postButton => `<div contenteditable="true" role="textbox" aria-label="Post text" aria-multiline="true" data-testid="tweetTextarea_0"><div><br></div></div>
<div data-testid="toolBar">${xComposerToolbar}<button type="button" data-testid="${postButton}" disabled>Post</button></div>`;
export const xComposeUploadHtml = `<!doctype html><meta charset="utf-8"><title>Compose post / X</title>
<style>body{margin:0;font:15px system-ui}input[type=file]{position:absolute;width:0;height:0;opacity:0}
#layers{position:fixed;inset:0;display:flex;justify-content:center;align-items:flex-start}
[aria-modal=true]{margin-top:40px;width:600px;background:#fff;padding:12px}</style>
<main aria-label="Home timeline"><div class="inline-composer">${xComposer('tweetButtonInline')}</div></main>
<div id="layers"><div role="dialog"><div role="dialog" aria-modal="true" aria-label="Compose post"><div role="group">
<button type="button" aria-label="Close">x</button>${xComposer('tweetButton')}</div></div></div></div>`;

// A page may replace its hidden transport wrapper with a directly clipped
// native slot after consuming the first attachment. Asset editors live next
// to the exclusive dropzone and remain part of the same release form.
// Instagram's direct-message thread as trace b71fd1dc read it (2026-10): no
// form, header or footer; the one file input, display:none by class between
// Voice Clip and Add Photo or Video, sits several wrappers deep below a
// thread too large for the page monitor's owner bounds, so no certificate
// covers it. rerenderComposerInput() swaps in an identical new input, as a
// re-mounted composer does. Owned names only.
export function instagramDirectThreadHtml(recipient = 'Owned Recipient', handle = 'owned.recipient') {
  const icon = label => `<div role="button" tabindex="0"><svg role="img" aria-label="${label}"><title>${label}</title><path d="M0 0h24v24H0z"/></svg></div>`;
  const nest = (html, depth) => Array.from({ length: depth }).reduce(inner => `<div>${inner}</div>`, html);
  const threads = ['Ungvb', recipient, 'Owned Contact One', 'Owned Contact Two', 'Owned Contact Three']
    .map(name => `<div role="button" tabindex="0"><img alt="user-profile-picture" src="data:,"><span>${name}</span></div>`).join('');
  const history = Array.from({ length: 60 }, (_, index) => nest(`<div role="group"><div role="article" data-message-direction="incoming">Message ${index + 1}</div></div>`, 5)).join('');
  const composer = `<div class="composer">${icon('Choose an emoji')}<div role="textbox" contenteditable="true" aria-placeholder="Message..." id="body"><p><br></p></div>`
    + `${icon('Voice Clip')}<input accept="audio/*,.mp4,.mov,.png,.jpg,.jpeg" class="x1s85apg" multiple type="file">${icon('Add Photo or Video')}${icon('Choose a GIF or sticker')}</div>`;
  return `<!doctype html><meta charset="utf-8"><title>Instagram • Messages</title>
<style>body{margin:0;font:14px sans-serif}.x1s85apg{display:none}#threads{position:fixed;left:72px;top:0;width:400px;height:700px;overflow:auto}
#pane{position:fixed;left:480px;top:0;width:640px;height:700px;display:flex;flex-direction:column}#head{height:75px}
#thread{flex:1;overflow:auto}.composer{display:flex;align-items:center;height:44px;margin:12px;border:1px solid #888;border-radius:22px}
[contenteditable]{flex:1;min-height:20px}[role=button]{display:inline-flex;width:40px;height:40px}svg{width:24px;height:24px}</style>
<div role="main"><div id="threads"><nav aria-label="Thread list"><h1>owned.account</h1>${threads}</nav></div>
<div id="pane"><div id="head"><a href="/${handle}/" aria-label="Open the profile page of ${handle}"><img alt="user-profile-picture" src="data:,"><h2>${recipient}</h2><span>${handle}</span></a>
${icon('Audio call')}${icon('Video call')}${icon('Conversation information')}</div>
<div id="thread" role="log">${history}</div>${nest(composer, 6)}</div></div>
<script>window.composerInputChanges=[];
const onComposerInputChange=event=>{composerInputChanges.push([...event.target.files].map(file=>file.name));window.dispatchEvent(new CustomEvent('composer-input-change',{detail:event.target}));};
document.querySelector('input[type=file]').addEventListener('change',onComposerInputChange);
window.rerenderComposerInput=()=>{const current=document.querySelector('input[type=file]'),next=current.cloneNode(false);
 next.addEventListener('change',onComposerInputChange);current.replaceWith(next);};</script>`;
}

export function stageSequentialReleaseUploads(hiding = 'clipped') {
  document.querySelectorAll('h1,h2').forEach(node => node.remove());
  const decoration = document.createElement('div'); decoration.hidden = true;
  decoration.innerHTML = '<span></span>'.repeat(300);
  const widget = document.getElementById('binary-widget');
  widget.after(decoration);
  const input = document.getElementById('releases-upload');
  input.addEventListener('change', () => {
    for (const file of input.files) {
      const row = document.createElement('div'); row.className = 'staged-asset';
      const name = document.createElement('input');
      name.setAttribute('aria-label', 'Change this file’s name'); name.value = file.name;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = 'Remove attached binary';
      row.append(name, remove); widget.before(row);
    }
    if (input.parentElement !== widget) input.parentElement.replaceWith(input);
    input.style.cssText = hiding === 'opacity'
      ? 'position:absolute;width:12px;height:12px;opacity:0;overflow:hidden'
      : 'position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden';
    input.value = '';
  });
}
