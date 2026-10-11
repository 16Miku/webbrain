export const telegramLab = `<!doctype html><title>WebBrain QA Bot</title><style>
body{font:18px sans-serif;margin:25px}.chat{width:850px}.topbar{padding:12px;background:#eee}.bubbles-scrollable{height:470px;overflow-y:auto}.bubble{padding:10px;margin:10px;border:1px solid #ccc}.is-out{background:#d9fdd3}.input-message-input{padding:14px;min-height:30px;border:1px solid #888}.time{font-size:11px}
</style><div class="chat"><div class="topbar"><div class="chat-info"><div class="user-title"><span class="peer-title" data-peer-id="123456">WebBrain QA Bot</span></div></div></div>
<div class="bubbles scrolled-down"><div class="bubbles-scrollable"><div class="bubbles-inner"></div></div></div><div class="input-message-input" role="textbox" aria-label="Message" data-peer-id="123456" contenteditable="true"></div><button aria-label="Send">Send</button></div>
<script>window.qaReplies=[];let mid=0;const questions=['What is one useful thing to test in a browser agent?','How would you detect a duplicate message?','What should happen when the user changes the instruction?','What should a cancelled run do?','How can a long chat avoid replying to old messages again?','Give one brief final quality check.'];
function row(text,own=false){const n=document.createElement('div');n.className='bubble '+(own?'is-out is-read':'is-in');n.dataset.mid=String(++mid);n.dataset.peerId='123456';n.dataset.timestamp=String(1791331200+mid);const body=document.createElement('div');body.className='message';body.append(document.createTextNode(text));const time=document.createElement('span');time.className='time';time.textContent=' 10:42';body.append(time);n.append(body);document.querySelector('.bubbles-inner').append(n);const scroller=document.querySelector('.bubbles-scrollable');scroller.scrollTop=scroller.scrollHeight;document.querySelector('.bubbles').classList.add('scrolled-down');}
function send(){const input=document.querySelector('.input-message-input');const text=input.textContent.trim();if(!text)return;window.qaReplies.push(text);input.textContent='';row(text,true);setTimeout(()=>row(window.qaReplies.length<questions.length?questions[window.qaReplies.length]:'QA dialogue complete: all six replies recorded.'),150);}
document.querySelector('button').onclick=send;document.querySelector('.input-message-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});row(questions[0]);</script>`;

// Two independent incoming identities precede the first delayed outgoing
// receipt. Both actual acknowledgments use the same body, so dedup must retain
// the original pending action's incoming anchor across the rendering race.
export const telegramRaceLab = telegramLab + `<script>
questions.splice(0,questions.length,'Confirm owned turn one?','Confirm owned turn two?');
document.querySelector('.bubble .message').firstChild.nodeValue=questions[0];
window.send=function(){const input=document.querySelector('.input-message-input');const text=input.textContent.trim();if(!text)return;
window.qaReplies.push(text);input.textContent='';
if(window.qaReplies.length===1){row(questions[1]);setTimeout(()=>row(text,true),900);}
else{row(text,true);setTimeout(()=>row('QA dialogue complete: both replies recorded.'),150);}};
document.querySelector('button').onclick=window.send;
</script>`;
