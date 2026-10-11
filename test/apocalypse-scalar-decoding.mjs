import test from 'node:test';
import assert from 'node:assert/strict';
import * as Chrome from '../src/chrome/src/agent/apocalypse-mode.js';
import * as Firefox from '../src/firefox/src/agent/apocalypse-mode.js';

// Exact existing synthetic ZIM builder; no archive files, browser, or network.
function minimalWikipediaZimFixture(options = {}) {
  const encoder = new TextEncoder();
  const language = options.language || 'eng';
  const sourceLanguage = ({ ben: 'bn', tgl: 'tl', tur: 'tr' })[language] || language.slice(0, 2);
  const articlePath = options.articlePath || 'Alan_Turing';
  const articleTitle = options.articleTitle || articlePath.replace(/_/g, ' ');
  const imageAssets = Array.isArray(options.imageAssets) ? options.imageAssets : [];
  const mimeTypes = ['text/html', 'text/plain'];
  for (const asset of imageAssets) {
    const mimeType = String(asset.mimeType || '').trim().toLowerCase();
    if (mimeType && !mimeTypes.includes(mimeType)) mimeTypes.push(mimeType);
  }
  const metadata = options.wikipedia === false ? {
    Language: 'eng', Name: 'project_gutenberg_en', Source: 'www.gutenberg.org', Tags: '_category:books',
  } : {
    Language: language, Name: `wikipedia_${sourceLanguage}_test`, Source: `https://${sourceLanguage}.wikipedia.org/`,
    Tags: options.tags ?? 'wikipedia;_category:wikipedia',
  };
  const articleNamespace = options.articleNamespace
    || (options.fullTextIndex === 'legacy' ? 'A' : 'C');
  const entries = [
    ...(options.fullTextIndex
      ? [{
        namespace: options.fullTextIndex === 'legacy' ? 'Z' : 'X',
        url: options.fullTextIndex === 'legacy' ? '/fulltextIndex/xapian' : 'fulltext/xapian',
        title: 'xapian', mimeType: 1, contents: 'not-a-real-index',
      }]
      : []),
    {
      namespace: articleNamespace, url: articlePath, title: articleTitle, mimeType: 0,
      contents: options.articleHtml || '<!doctype html><html><body><p>Alan Turing was an English mathematician, computer scientist, logician, and cryptanalyst.</p></body></html>',
    },
    ...Object.entries(metadata).map(([url, contents]) => ({ namespace: 'M', url, title: url, mimeType: 1, contents })),
    ...imageAssets.map(asset => ({
      namespace: 'C',
      url: String(asset.url || ''),
      title: String(asset.title || asset.url || ''),
      mimeType: mimeTypes.indexOf(String(asset.mimeType || '').trim().toLowerCase()),
      contents: asset.contents,
    })),
  ];
  if (options.redirectTrap) {
    entries.push(
      { namespace: 'C', url: 'Science', title: 'Science', redirectUrl: 'The_New_York_Times' },
      { namespace: 'C', url: 'Science_article', title: 'Science article', mimeType: 0, contents: '<p>Science is the systematic study of the natural world.</p>' },
      { namespace: 'C', url: 'The_New_York_Times', title: 'The New York Times', mimeType: 0, contents: '<p>A newspaper based in New York City.</p>' },
    );
  }
  if (options.caseSensitiveTitle) {
    for (let index = 0; index < 30; index += 1) {
      entries.push({
        namespace: 'C', url: `New_Example_${String(index).padStart(2, '0')}`, title: `New Example ${index}`, mimeType: 0,
        contents: `<p>Prefix decoy ${index}.</p>`,
      });
    }
    entries.push({
      namespace: 'C', url: 'New_York_City', title: 'New York City', mimeType: 0,
      contents: '<p>New York City is the most populous city in the United States.</p>',
    });
    entries.push({ namespace: 'C', url: 'NYC', title: 'NYC', redirectUrl: 'New_York_City' });
    entries.push({
      namespace: 'C', url: 'iPhone', title: 'iPhone', mimeType: 0,
      contents: '<p>The iPhone is a line of smartphones designed by Apple.</p>',
    });
    entries.push({
      namespace: 'C', url: 'YouTube', title: 'YouTube', mimeType: 0,
      contents: '<p>YouTube is an online video sharing platform.</p>',
    });
    entries.push({
      namespace: 'C', url: 'YouTube_TV', title: 'YouTube TV', mimeType: 0,
      contents: '<p>YouTube TV is a streaming television service.</p>',
    });
    entries.push({
      namespace: 'C', url: 'OpenAI', title: 'OpenAI', mimeType: 0,
      contents: '<p>OpenAI is an artificial intelligence research organization.</p>',
    });
    entries.push({
      namespace: 'C', url: 'United_States', title: 'United States', mimeType: 0,
      contents: '<p>The United States is a country in North America.</p>',
    });
    entries.push({ namespace: 'C', url: 'USA', title: 'USA', redirectUrl: 'United_States' });
    entries.push({ namespace: 'C', url: 'Big_Apple', title: 'Big Apple', redirectUrl: 'New_York_City' });
  }
  entries.sort((left, right) => {
    const leftKey = `${left.namespace}/${left.url}`;
    const rightKey = `${right.namespace}/${right.url}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const blobs = entries.filter(entry => entry.contents != null);
  blobs.forEach((entry, index) => { entry.blobIndex = index; });
  const mime = encoder.encode(`${mimeTypes.join('\0')}\0\0`);
  const offsetsBytes = (blobs.length + 1) * 4;
  const encodedBlobs = blobs.map((entry) => {
    if (entry.contents instanceof Uint8Array) return entry.contents;
    if (ArrayBuffer.isView(entry.contents)) {
      return new Uint8Array(entry.contents.buffer, entry.contents.byteOffset, entry.contents.byteLength);
    }
    if (entry.contents instanceof ArrayBuffer) return new Uint8Array(entry.contents);
    return encoder.encode(String(entry.contents));
  });
  const cluster = new Uint8Array(1 + offsetsBytes + encodedBlobs.reduce((sum, value) => sum + value.length, 0));
  cluster[0] = 1;
  const clusterView = new DataView(cluster.buffer);
  let blobOffset = offsetsBytes;
  encodedBlobs.forEach((value, index) => {
    clusterView.setUint32(1 + index * 4, blobOffset, true);
    cluster.set(value, 1 + blobOffset);
    blobOffset += value.length;
  });
  clusterView.setUint32(1 + blobs.length * 4, blobOffset, true);
  const directories = entries.map((entry) => {
    const url = encoder.encode(entry.url);
    const title = encoder.encode(entry.title);
    const redirect = Boolean(entry.redirectUrl);
    const directory = new Uint8Array((redirect ? 12 : 16) + url.length + 1 + title.length + 1);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint16(0, redirect ? 0xffff : entry.mimeType, true);
    directory[3] = entry.namespace.charCodeAt(0);
    directoryView.setUint32(8, redirect ? entries.findIndex(candidate => candidate.url === entry.redirectUrl && candidate.namespace === 'C') : 0, true);
    if (!redirect) directoryView.setUint32(12, entry.blobIndex, true);
    directory.set(url, redirect ? 12 : 16);
    directory.set(title, (redirect ? 13 : 17) + url.length);
    return directory;
  });
  // Use the common ZIM layout where directory entries precede cluster data.
  // The final cluster therefore ends at checksumPos, not at the first URL
  // pointer's directory-entry offset.
  const urlPointerPosition = Math.max(128, Math.ceil((80 + mime.length) / 8) * 8);
  const clusterPointerPosition = urlPointerPosition + entries.length * 8;
  const directoryStart = clusterPointerPosition + 8;
  const directoryPositions = [];
  let directoryOffset = directoryStart;
  for (const directory of directories) {
    directoryPositions.push(directoryOffset);
    directoryOffset += directory.length;
  }
  const clusterStart = directoryOffset;
  const checksumPosition = clusterStart + cluster.length;
  const bytes = new Uint8Array(checksumPosition + 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x044d495a, true);
  view.setUint16(4, 6, true);
  view.setUint16(6, 3, true);
  view.setUint32(24, entries.length, true);
  view.setUint32(28, 1, true);
  view.setBigUint64(32, BigInt(urlPointerPosition), true);
  view.setBigUint64(40, 0xffffffffffffffffn, true);
  view.setBigUint64(48, BigInt(clusterPointerPosition), true);
  view.setBigUint64(56, 80n, true);
  view.setUint32(64, 0, true);
  view.setUint32(68, 0xffffffff, true);
  view.setBigUint64(72, BigInt(checksumPosition), true);
  bytes.set(mime, 80);
  bytes.set(cluster, clusterStart);
  directories.forEach((directory, index) => {
    bytes.set(directory, directoryPositions[index]);
    view.setBigUint64(urlPointerPosition + index * 8, BigInt(directoryPositions[index]), true);
  });
  view.setBigUint64(clusterPointerPosition, BigInt(clusterStart), true);
  return new Blob([bytes], { type: 'application/x-zim' });
}

const replacement = '\uFFFD';
const invalid = [
 ['decimal zero', '&#0;'], ['hex zero', '&#x0;'],
 ['first surrogate', '&#55296;'], ['last surrogate', '&#xDFFF;'],
 ['decimal beyond Unicode', '&#1114112;'], ['hex beyond Unicode', '&#x110000;'],
 ['oversized decimal', '&#' + '9'.repeat(400) + ';'],
 ['oversized hexadecimal', '&#x' + 'F'.repeat(400) + ';'],
];
for (const [engine, runtime] of [['chrome', Chrome], ['firefox', Firefox]]) {
 for (const [label, entity] of invalid) {
  test(engine + ': malformed scalar ' + label + ' is replaceable article text', async () => {
   const archive = await runtime.openKiwixZim(minimalWikipediaZimFixture({ articleHtml: '<p>Alan Turing before ' + entity + ' after.</p>' }));
   const article = await archive.readArticle('Alan_Turing');
   assert.equal(article.text, 'Alan Turing before ' + replacement + ' after.');
   assert.equal(article.unsafeHtml, '<p>Alan Turing before ' + entity + ' after.</p>');
   const results = await archive.search('Alan Turing');
   assert.equal(results.length, 1);
   assert.equal(results[0].excerpt, article.text);
  });
 }
 test(engine + ': valid scalars and preexisting stripping/entity order remain', async () => {
  const html='<script>discard &#1114112;</script><style>discard</style><!--discard--><p>Alan Turing &#65; &#x1F9E0; &#1114111; &#xD7FF; &#xE000; &#x80; &#0000000000065; &#x000000000041; &amp;#1114112; &amp;lt;tag&amp;gt;</p><p>Second line.</p>';
  const archive=await runtime.openKiwixZim(minimalWikipediaZimFixture({articleHtml:html}));
  const expected='Alan Turing A 🧠 '+String.fromCodePoint(0x10ffff)+' '+String.fromCodePoint(0xd7ff)+' '+String.fromCodePoint(0xe000)+' '+String.fromCodePoint(0x80)+' A A &#1114112; <tag>';
  const article=await archive.readArticle('Alan_Turing');
  assert.equal(article.text,expected+'\nSecond line.');
  assert.equal((await archive.search('Alan Turing'))[0].excerpt,expected+' Second line.');
  assert.equal(article.unsafeHtml,html);
 });
 test(engine + ': actual search/read callers preserve ready archive after one malformed article', async () => {
  const blob=minimalWikipediaZimFixture({articleHtml:'<p>Alan Turing before &#x110000; after.</p>', imageAssets:[{url:'Second_Article',title:'Second Article',mimeType:'text/html',contents:'<p>Second Article remains available.</p>'}]});
  let current={id:engine+'-archive',archiveKind:'wikipedia',filename:'synthetic.zim',status:'ready',generation:1,updatedAt:1,size:blob.size,target:{kind:'opfs',key:'synthetic'}};
  const writes=[];
  const store={async getConfig(){return {enabled:true};},async listArchives(){return [current];},async getArchive(id){assert.equal(id,current.id);return current;},async putArchive(next){writes.push(next);current=next;}};
  const provider=runtime.createKiwixZimProvider({storage:{async open(target){assert.equal(target,current.target);return blob;}},archiveCache:new Map()});
  const options={store,providers:[provider]};
  let results, failure;
  try { results=await runtime.searchApocalypseArchives('Alan Turing',options); } catch(error) { failure=error; }
  assert.equal(current.status,'ready',failure?.message); assert.equal(writes.length,0);
  if(failure) throw failure;
  assert.equal(results.length,1);
  assert.equal(results[0].excerpt,'Alan Turing before '+replacement+' after.');
  const article=await runtime.readApocalypseArticle(current.id,'Alan_Turing',options);
  assert.equal(article.text,results[0].excerpt);
  const second=await runtime.readApocalypseArticle(current.id,'Second_Article',options);
  assert.equal(second.text,'Second Article remains available.');
  assert.equal((await runtime.searchApocalypseArchives('Second Article',options))[0].path,'Second_Article');
  assert.equal(current.status,'ready'); assert.equal(writes.length,0);
 });
 test(engine + ': real corrupt archive still becomes unreadable and abort does not mutate state', async () => {
  const corrupt=new Blob([new Uint8Array(96)]);
  let current={id:engine+'-corrupt',archiveKind:'wikipedia',filename:'corrupt.zim',status:'ready',generation:1,updatedAt:1,size:corrupt.size,target:{kind:'opfs',key:'corrupt'}};
  const writes=[];
  const store={async getConfig(){return {enabled:true};},async listArchives(){return [current];},async getArchive(){return current;},async putArchive(next){writes.push(next);current=next;}};
  const provider=runtime.createKiwixZimProvider({storage:{async open(){return corrupt;}},archiveCache:new Map()});
  const controller=new AbortController();controller.abort();
  await assert.rejects(runtime.searchApocalypseArchives('Alan Turing',{store,providers:[provider],signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(current.status,'ready');assert.equal(writes.length,0);
  await assert.rejects(runtime.searchApocalypseArchives('Alan Turing',{store,providers:[provider]}),/Installed archive could not be read/);
  assert.equal(current.status,'error');assert.equal(current.errorKind,'archive-unreadable');assert.equal(writes.length,1);
 });
}
