import test from 'node:test';
import assert from 'node:assert/strict';
import { extract, createProcessor } from '../public/lib/parse.js';

const SAMPLE = [
  '[https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi)1111',
  'https://x.com/a/b:user1:pass1',
  'random line without any pair',
  'prefix    sp4ce:secret42   suffix',
  'https://monsite.com:8080/page',
  'a:b c:d',
];

test('dernier couple de la ligne (mode par défaut)', () => {
  assert.equal(
    extract(SAMPLE.join('\n')),
    'Thou_miriba:N2Z6PQXg4XLnTSi\nuser1:pass1\nsp4ce:secret42\nc:d\n'
  );
});

test('premier couple de la ligne', () => {
  assert.equal(
    extract(SAMPLE.join('\n'), { mode: 'first' }),
    'CreateAccount:Thou_miriba\nb:user1\nsp4ce:secret42\na:b\n'
  );
});

test('le plus long pass de la ligne (à égalité : le plus à droite)', () => {
  assert.equal(
    extract(SAMPLE.join('\n'), { mode: 'longest' }),
    'Thou_miriba:N2Z6PQXg4XLnTSi\nuser1:pass1\nsp4ce:secret42\nc:d\n'
  );
});

test('tous les couples', () => {
  assert.equal(
    extract('a:b c:d', { mode: 'all' }),
    'a:b\nc:d\n'
  );
});

test('hôte:port avec point est ignoré, mais 127.0.0.1:8080 est gardé', () => {
  assert.equal(extract('https://monsite.com:8080/x'), '');
  assert.equal(extract('https://127.0.0.1:8080/x'), '127.0.0.1:8080\n');
  assert.equal(extract('https://monsite.com:8080/x', { hosts: true }), 'monsite.com:8080\n');
});

test('un run de 3 segments donne les deux couples adjacents', () => {
  assert.equal(extract('a:b:c'), 'b:c\n');
  assert.equal(extract('a:b:c', { mode: 'first' }), 'a:b\n');
  assert.equal(extract('a:b:c', { mode: 'all' }), 'a:b\nb:c\n');
});

test('CRLF, espaces et lignes vides', () => {
  assert.equal(extract('\r\n  :  \r\nok:1\r\n'), 'ok:1\n');
});

test('dedupe', () => {
  assert.equal(extract('a:b\nc:d\na:b\n', { dedupe: true }), 'a:b\nc:d\n');
});

test('mode custom avec regex perso', () => {
  assert.equal(extract('x <user:pass> y', { mode: 'custom', regex: '<([^>]+)>' }), 'user:pass\n');
  assert.equal(extract('id=42', { mode: 'custom', regex: 'id=(\\d+)' }), '42\n');
});

test('regex perso invalide → erreur claire', () => {
  assert.throws(() => extract('a', { mode: 'custom', regex: '([a' }), /Invalid regular expression|invalide/i);
});

test('fichier sans saut de ligne final', () => {
  assert.equal(extract('a:b'), 'a:b\n');
});

test('push par morceaux arbitraires = même résultat', () => {
  const text = SAMPLE.join('\n');
  for (const size of [1, 2, 3, 7, 13, 64]) {
    const processor = createProcessor({});
    let out = '';
    for (let i = 0; i < text.length; i += size) out += processor.push(text.slice(i, i + size));
    out += processor.flush();
    assert.equal(out, extract(text), 'découpe de ' + size + ' caractères');
  }
});

test('octets UTF-8 coupés au milieu d’un caractère', () => {
  const bytes = new TextEncoder().encode('café réseau → user:wörld42\n');
  const processor = createProcessor({});
  let out = '';
  for (const byte of bytes) out += processor.pushBytes(Uint8Array.of(byte));
  out += processor.flush();
  assert.equal(out, 'user:wörld42\n');
});

test('les lettres accentuées sont acceptées dans un couple', () => {
  assert.equal(extract('héllo:wörld\n'), 'héllo:wörld\n');
});

test('BOM UTF-8 retiré', () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('a:b\n')]);
  const processor = createProcessor({});
  assert.equal(processor.pushBytes(bytes) + processor.flush(), 'a:b\n');
});

test('UTF-16 avec BOM', () => {
  const utf16 = Buffer.from('\ufeffu:p\n', 'utf16le');
  const processor = createProcessor({});
  const out = processor.pushBytes(new Uint8Array(utf16)) + processor.flush();
  assert.equal(out, 'u:p\n');
});

test('passes : comptage puis tranches, sans doublon ni trou', () => {
  const text = Array.from({ length: 500 }, (_, i) => 'http://x/y:user' + i + ':pass' + i + '\n').join('');
  const expected = extract(text);
  const count = createProcessor({ count: true });
  count.push(text);
  count.flush();
  const total = count.stats().outChars;
  assert.equal(total, expected.length, 'la passe de comptage annonce la bonne taille');
  assert.equal(count.stats().outLines, 500);

  let joined = '';
  let skip = 0;
  for (let part = 0; part < 3; part++) {
    const processor = createProcessor({ skip, limit: Math.ceil(total / 3) });
    joined += processor.push(text);
    joined += processor.flush();
    skip += processor.stats().emittedBytes;
  }
  assert.equal(joined, expected, 'les tranches recollées donnent exactement la sortie complète');
});

test('passes + dedupe : mêmes valeurs gardées d’une passe à l’autre', () => {
  const text = Array.from({ length: 200 }, (_, i) => 'x:u' + (i % 50) + ':p' + (i % 50) + '\n').join('');
  const count = createProcessor({ dedupe: true, count: true });
  count.push(text);
  count.flush();
  const total = count.stats().outChars;
  assert.equal(count.stats().outLines, 50);

  let joined = '';
  let skip = 0;
  for (let part = 0; part < 4; part++) {
    const processor = createProcessor({ dedupe: true, skip, limit: Math.ceil(total / 4) });
    joined += processor.push(text);
    joined += processor.flush();
    skip += processor.stats().emittedBytes;
  }
  assert.equal(joined.trim().split('\n').length, 50);
  assert.equal(new Set(joined.trim().split('\n')).size, 50);
});

test('le résultat est exact sur un gros volume généré', () => {
  const lines = 20000;
  const parts = [];
  for (let i = 0; i < lines; i++) parts.push('junk://host/path:user' + i + ':pw' + i + '!');
  const text = parts.join('\n');
  const expected = [];
  for (let i = 0; i < lines; i++) expected.push('user' + i + ':pw' + i);
  assert.equal(extract(text), expected.join('\n') + '\n');
});

test('chemins rapides et chemin regex donnent le même résultat (aléatoire)', () => {
  const alphabet = ['a', 'B', '9', '_', '-', '.', '@', '+', ':', '/', ' ', '[', ']', '(', ')', '<', 'é', '→', ',', '#', '?', '&', '%', '|', '\t', '1', '2'];
  let seed = 987654321;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let n = 0; n < 5000; n++) {
    let line = '';
    const len = 1 + Math.floor(rnd() * 40);
    for (let i = 0; i < len; i++) line += alphabet[Math.floor(rnd() * alphabet.length)];
    for (const keepHosts of [false, true]) {
      const all = extract(line, { mode: 'all', hosts: keepHosts });
      const pairs = all ? all.slice(0, -1).split('\n') : [];
      assert.equal(
        extract(line, { mode: 'last', hosts: keepHosts }),
        pairs.length ? pairs[pairs.length - 1] + '\n' : '',
        'last ' + JSON.stringify(line)
      );
      assert.equal(
        extract(line, { mode: 'first', hosts: keepHosts }),
        pairs.length ? pairs[0] + '\n' : '',
        'first ' + JSON.stringify(line)
      );
      if (pairs.length) {
        let longest = pairs[0];
        for (const pair of pairs) {
          const a = pair.length - pair.indexOf(':');
          const b = longest.length - longest.indexOf(':');
          if (a >= b) longest = pair;
        }
        assert.equal(extract(line, { mode: 'longest', hosts: keepHosts }), longest + '\n', 'longest ' + JSON.stringify(line));
      }
    }
  }
});

test('lignes réelles de dump : résultat identique quel que soit le découpage', () => {
  const line = '[https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi)1111';
  const text = Array.from({ length: 500 }, () => line).join('\n');
  const expected = Array.from({ length: 500 }, () => 'Thou_miriba:N2Z6PQXg4XLnTSi').join('\n') + '\n';
  assert.equal(extract(text), expected);
  // découpage en blocs d'octets de tailles variées, y compris à cheval sur un caractère
  const bytes = Buffer.from(text, 'utf8');
  for (const size of [7, 64, 997, 4096]) {
    const processor = createProcessor({});
    let out = '';
    for (let i = 0; i < bytes.length; i += size) out += processor.pushBytes(bytes.subarray(i, i + size));
    out += processor.flush();
    assert.equal(out, expected, 'blocs de ' + size + ' octets');
  }
});
