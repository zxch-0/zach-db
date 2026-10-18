/*
 * Teste le socle de l'outil « Guns.lol views » : lecture du pseudo, lecture des
 * listes de proxys, lecture du challenge, en-têtes, BLAKE3 (vecteurs officiels)
 * et proof-of-work. Aucun réseau : tout est vérifiable hors ligne.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BROWSERS,
  documentHeaders,
  extractSlug,
  guessViews,
  parseChallenge,
  parseProxyLine,
  parseProxyList,
  pathOf,
  pixelUrl,
  profileUrl,
} from '../public/lib/guns.js';
import { blake3Hex, findSeal, solvePow } from '../public/lib/guns-api.js';

test('pseudo : accepte le pseudo nu, la mention et l’adresse de profil', () => {
  assert.equal(extractSlug('zach'), 'zach');
  assert.equal(extractSlug('  @zach  '), 'zach');
  assert.equal(extractSlug('guns.lol/zach'), 'zach');
  assert.equal(extractSlug('https://guns.lol/zach'), 'zach');
  assert.equal(extractSlug('https://www.guns.lol/zach/?x=1#y'), 'zach');
  assert.equal(extractSlug('https://guns.lol/zach/profile'), 'zach');
  assert.equal(extractSlug('un_beau.pseudo-2'), 'un_beau.pseudo-2');
  assert.equal(profileUrl('zach'), 'https://guns.lol/zach');
});

test('pseudo : refuse le bruit', () => {
  assert.equal(extractSlug(''), null);
  assert.equal(extractSlug(null), null);
  assert.equal(extractSlug('https://example.com/zach'), 'zach');
  assert.equal(extractSlug('a'.repeat(41)), null);
  assert.equal(extractSlug('-mauvais'), null);
});

test('proxys : lecture, formats variés, dédoublonnage', () => {
  assert.deepEqual(parseProxyLine('1.2.3.4:8080'), { host: '1.2.3.4', port: 8080, auth: null });
  assert.deepEqual(parseProxyLine('http://1.2.3.4:8080'), { host: '1.2.3.4', port: 8080, auth: null });
  assert.deepEqual(parseProxyLine('user:pass@proxy.example:3128'),
    { host: 'proxy.example', port: 3128, auth: 'user:pass' });
  assert.equal(parseProxyLine('# commentaire'), null);
  assert.equal(parseProxyLine('1.2.3.4'), null);
  assert.equal(parseProxyLine('1.2.3.4:99999'), null);
  assert.equal(parseProxyLine('1.2.3.4:0'), null);

  const list = parseProxyList('1.2.3.4:80\n1.2.3.4:80\n5.6.7.8:3128, 9.9.9.9:8080\n');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((proxy) => proxy.host), ['1.2.3.4', '5.6.7.8', '9.9.9.9']);
  assert.equal(parseProxyList('1.2.3.4:80\n5.6.7.8:81', { limit: 1 }).length, 1);
});

test('challenge : lecture de « _gpp_ch » dans le HTML échappé', () => {
  const html = 'x<script>{"_gpp_ch":[1760000000000,\\"ab\\",\\"sel\\",\\"tok\\"],\\"success\\":true}</script>';
  assert.deepEqual(parseChallenge(html), [1760000000000, 'ab', 'sel', 'tok']);

  assert.equal(parseChallenge('<p>rien</p>'), null);
  assert.equal(parseChallenge('"_gpp_ch":[1,2,3]'), null);
  assert.deepEqual(parseChallenge('"_gpp_ch":[1,2,3,4],"x"'), [1, 2, 3, 4]);
});

test('pixel : l’adresse porte l’hôte, le chemin et le type d’événement', () => {
  const url = pixelUrl('zach', { random: () => 0.5, browser: BROWSERS[0] });
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.ok(url.startsWith('https://sa.guns.lol/simple.gif?'));
  assert.equal(params.get('hostname'), 'guns.lol');
  assert.equal(params.get('path'), '/zach');
  assert.equal(params.get('type'), 'pageview');
  assert.equal(params.get('unique'), 'true');
  assert.equal(params.get('ua'), BROWSERS[0].ua);
  assert.match(params.get('brands'), /Google Chrome/);
  assert.equal(pathOf(url), url.slice('https://sa.guns.lol'.length));
});

test('en-têtes : une navigation crédible', () => {
  const headers = documentHeaders(BROWSERS[0], () => 0.1);
  assert.match(headers['user-agent'], /^Mozilla\/5\.0 \(.*Chrome\/\d+/);
  assert.equal(headers['sec-fetch-mode'], 'navigate');
  assert.equal(headers['sec-fetch-dest'], 'document');
  assert.equal(headers['accept-language'], 'en-US,en;q=0.9');
  assert.equal(headers.referer, undefined);
  assert.match(headers['sec-ch-ua'], /Google Chrome/);
});

test('compteur : lecture au mieux, jamais inventée', () => {
  assert.equal(guessViews('{"views":1234}'), 1234);
  assert.equal(guessViews('{"total_views": "1 234"}'), 1234);
  assert.equal(guessViews('<p>rien</p>'), null);
  assert.equal(guessViews(''), null);
});

test('BLAKE3 : vecteurs officiels (0, 1 et 1024 octets)', () => {
  const pattern = (length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = i % 251;
    return bytes;
  };
  assert.equal(blake3Hex(pattern(0)), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.equal(blake3Hex(pattern(1)), '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213');
  assert.equal(blake3Hex(pattern(1024)), '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7');
  assert.equal(blake3Hex('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  assert.equal(blake3Hex(''), blake3Hex(new Uint8Array(0)));
});

test('proof-of-work : le sceau est retrouvé, le nonce se recolle', () => {
  const difficulty = 5;
  const positions = [3, 11, 24, 40, 55];
  const nibbles = ['a', 'b', 'c', 'd', 'e'];
  const target = 'z'.repeat(59);
  const salt = 'sel-2026';
  const timestamp = 1760000000000;

  // le sceau, reconstruit exactement comme le serveur l'a amputé
  const chars = target.split('');
  positions.forEach((position, index) => chars.splice(position, 0, nibbles[index]));
  const seal = chars.join('');
  assert.equal(seal.length, 64);

  const suffix = Buffer.from(salt + String(timestamp), 'utf8');
  const targetHash = createHash('sha256').update(seal).update(suffix).digest();
  assert.equal(findSeal(target, positions, targetHash, suffix), seal);

  const token = Buffer.concat([
    Buffer.from([0, 0, difficulty]),
    Buffer.from(positions),
    Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from('ABCDEFGH', 'latin1'),
    Buffer.from(target, 'latin1'),
  ]);
  assert.equal(token.length, 80);

  const challenge = [timestamp, targetHash.toString('hex'), salt, token.toString('base64url')];
  const solved = solvePow(challenge, { random: () => 0.5 });

  assert.equal(solved.length, 6);
  assert.equal(solved[0], token.toString('base64url'));
  assert.equal(solved[1], timestamp);
  assert.equal(solved[4].length, 66, 'le sceau part avec deux caractères ajoutés');
  assert.notEqual(solved[4], seal);

  const nonce = Buffer.from(solved[5], 'base64url');
  assert.equal(nonce.length, 19);
  assert.equal(nonce[0], 0x51);
  assert.equal(nonce[1], difficulty);
  const sent = nonce.subarray(2, 2 + difficulty).toString('latin1');
  assert.equal(sent, positions.map((position) => seal[position]).join(''));
  assert.equal(nonce.subarray(2 + difficulty).length, 12, 'score (4) + intégrité (8)');
});
