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
