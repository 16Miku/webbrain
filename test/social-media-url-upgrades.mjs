import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const paths = [
  ['chrome', '../src/chrome/src/agent/social-media-downloader.js'],
  ['firefox', '../src/firefox/src/agent/social-media-downloader.js'],
  ['standalone fixture', './smd-tests/social-media-downloader.js'],
];
const supported = [
  ['https://i.pinimg.com/236x/ab/photo.jpg', 'https://i.pinimg.com/originals/ab/photo.jpg'],
  ['https://v1.pinimg.com/736x1104_RS/ab/photo.jpg?tag=1#image', 'https://v1.pinimg.com/originals/ab/photo.jpg?tag=1#image'],
  ['https://pinimg.com/736x_AC/photo.jpg', 'https://pinimg.com/originals/photo.jpg'],
  ['https://i.pinimg.com/originals/photo.jpg', 'https://i.pinimg.com/originals/photo.jpg'],
  ['https://pbs.twimg.com/media/pic?format=jpg&name=small#image', 'https://pbs.twimg.com/media/pic?format=jpg&name=orig#image'],
  ['https://preview.redd.it/pic.jpg?width=300&height=200&blur=40&format=pjpg&s=token#image', 'https://preview.redd.it/pic.jpg?s=token#image'],
  ['https://external-preview.redd.it/pic.jpg?width=1&s=token', 'https://external-preview.redd.it/pic.jpg?s=token'],
  ['https://i.pinimg.com/736x/photo.jpg?source=pinimg.com/236x/other.jpg', 'https://i.pinimg.com/originals/photo.jpg?source=pinimg.com/236x/other.jpg'],
];
const unchanged = [
  'https://example.invalid/pinimg.com/236x/photo.jpg',
  'https://example.invalid/photo.jpg?redirect=https://i.pinimg.com/236x/photo.jpg',
  'https://example.invalid/photo.jpg#pinimg.com/236x/photo.jpg',
  'https://evilpinimg.com/236x/photo.jpg',
  'https://i.pinimg.com.evil.invalid/236x/photo.jpg',
  'https://example.invalid/pbs.twimg.com/media/photo.jpg?name=small',
  'https://example.invalid/photo.jpg?source=https://pbs.twimg.com/media/a',
  'https://pbs.twimg.com.evil.invalid/media/photo.jpg?name=small',
  'https://example.invalid/preview.redd.it/photo.jpg?width=20&height=10&s=token',
  'https://example.invalid/photo.jpg?source=external-preview.redd.it&width=20',
  'https://preview.redd.it.evil.invalid/photo.jpg?width=20',
  'https://i.pinimg.com/arbitrary/236x/photo.jpg',
  'https://pbs.twimg.com/profile_images/photo.jpg?name=small',
  'ftp://i.pinimg.com/236x/photo.jpg',
  'not-a-url-pinimg.com/236x/photo.jpg',
];

for (const [label, relative] of paths) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const realm = {
    URL, console: {log() {}, warn() {}, error() {}},
    location: {href:'https://example.invalid/post', hostname:'example.invalid', pathname:'/post', search:''},
    document: {}, setTimeout, clearTimeout,
    fetch() { throw new Error('URL upgrade tests must not fetch'); },
  };
  realm.window = realm;
  vm.runInNewContext(source, realm, {filename:relative, timeout:1000});
  const upgrade = values => Array.from(realm.SocialMediaDownloader._preferHighQuality(values));
  for (const [input, expected] of supported) test(`${label}: preserves supported upgrade ${input}`, () => {
    assert.deepEqual(upgrade([input]), [expected]);
  });
  for (const input of unchanged) test(`${label}: unrelated/unsupported URL stays exact ${input}`, () => {
    assert.deepEqual(upgrade([input]), [input]);
  });
  test(`${label}: cleanup and dedup retain original public semantics`, () => {
    assert.deepEqual(upgrade([
      'https://pbs.twimg.com/media/pic?format=jpg&amp;name=small',
      'https://pbs.twimg.com/media/pic?format=jpg&name=orig',
    ]), ['https://pbs.twimg.com/media/pic?format=jpg&name=orig']);
  });
}
