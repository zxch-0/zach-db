import test from 'node:test';
import assert from 'node:assert/strict';
import { createGrouper, siteFromLine, normalizeSite, NO_SITE } from '../public/lib/group.js';
import { extract } from '../public/lib/parse.js';

const SAMPLE = [
  '[https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi](https://www.roblox.com/tr/CreateAccount:Thou_miriba:N2Z6PQXg4XLnTSi)1111',
  'http://www.netflix.com/browse/login:user1:pass1',
  'https://account.roblox.com/login:user2:pass2',
  'https://ROBLOX.com/x:user3:pass3',
  'https://www.roblox.co.uk/x:user4:pass4',
  'https://1.2.3.4:8080/panel:admin:1111:admin',
  '//cdn.netflix.com/a:b:c',
  'ligne sans site ici:aaa:bbb',
  'https://monsite.com:443/a:user5:pass5',
];

function group(lines, options = {}) {
  const grouper = createGrouper(options);
  grouper.push(lines.join('\n') + '\n');
  grouper.flush();
  const out = new Map();
  for (const entry of grouper.order()) out.set(entry.site, entry);
  return { grouper, map: out };
}

test('site d’une ligne : schéma, sans schéma, sous-domaine, port, IP', () => {
  assert.equal(siteFromLine('https://www.roblox.com/tr/x:1:2'), 'www.roblox.com');
  assert.equal(siteFromLine('http://netflix.com:8080/a:b:c'), 'netflix.com');
  assert.equal(siteFromLine('//cdn.site.io/a:b:c'), 'cdn.site.io');
  assert.equal(siteFromLine('roblox.com/login:user:pass'), 'roblox.com');
  assert.equal(siteFromLine('prefix https://x.y.fr/a:b:c suffix'), 'x.y.fr');
  assert.equal(siteFromLine('scheme://user:pass@host.com/1:2:3'), 'host.com');
  assert.equal(siteFromLine('1.2.3.4:8080:u:p'), '1.2.3.4');
  assert.equal(siteFromLine('aucun site ici:aaa:bbb'), null);
  assert.equal(siteFromLine('fichier.txt:aaa:bbb'), 'fichier.txt'); // chemin sans URL
  assert.equal(siteFromLine(''), null);
});

test('normalisation des sous-domaines', () => {
  assert.equal(normalizeSite('WWW.Roblox.com'), 'roblox.com');
  assert.equal(normalizeSite('account.roblox.com'), 'roblox.com');
  assert.equal(normalizeSite('roblox.com'), 'roblox.com');
  assert.equal(normalizeSite('a.b.roblox.co.uk'), 'roblox.co.uk');
  assert.equal(normalizeSite('1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeSite('www.roblox.com', { stripSubdomains: false }), 'www.roblox.com');
  assert.equal(normalizeSite('account.roblox.com', { stripSubdomains: false }), 'account.roblox.com');
});

test('groupement : compteurs, valeurs et ordre', () => {
  const { map } = group(SAMPLE);
  assert.equal(map.get('roblox.com').count, 3); // roblox.com, account.roblox.com, ROBLOX.com
  assert.equal(map.get('roblox.com').text.split('\n')[0], 'Thou_miriba:N2Z6PQXg4XLnTSi');
  assert.equal(map.get('netflix.com').count, 2); // netflix.com + cdn.netflix.com
  assert.equal(map.get('roblox.co.uk').count, 1); // TLD en deux lettres : domaine distinct
  assert.equal(map.get('1.2.3.4').text, '1111:admin\n'); // dernier couple de la ligne
  assert.equal(map.get('monsite.com').text, 'user5:pass5\n');
  assert.equal(map.get(NO_SITE).text, 'aaa:bbb\n');
});

test('mode first / all / custom côté site', () => {
  const first = group(SAMPLE, { mode: 'first' }).map;
  assert.equal(first.get('roblox.com').text.split('\n')[0], 'CreateAccount:Thou_miriba');

  const all = group(['https://a.com/x:u1:p1 site2.net/y:u2:p2'], { mode: 'all' }).map;
  // mêmes couples que l'onglet "Extraire" (segments séparés par ':')
  assert.equal(all.get('a.com').text, 'x:u1\nu1:p1\ny:u2\nu2:p2\n');

  const custom = group(['https://a.com/x::1234::'], { mode: 'custom', regex: '::(\\d+)::' }).map;
  assert.equal(custom.get('a.com').text, '1234\n');
});

test('sous-domaines non regroupés', () => {
  const { map } = group(SAMPLE, { stripSubdomains: false });
  assert.equal(map.has('www.roblox.com'), true);
  assert.equal(map.has('account.roblox.com'), true);
  assert.equal(map.has('roblox.com'), true);
});

test('dédoublonnage : par site, pas global', () => {
  const lines = [
    'https://a.com/x:u1:p1',
    'https://b.com/x:u1:p1', // même valeur, autre site → conservée
    'https://a.com/y:u1:p1', // doublon dans a.com → supprimé
    'https://a.com/z:u2:p2',
  ];
  const { map } = group(lines, { dedupe: true });
  assert.equal(map.get('a.com').count, 2);
  assert.equal(map.get('a.com').text, 'u1:p1\nu2:p2\n');
  assert.equal(map.get('b.com').count, 1);
});

test('un seul site demandé (onlySite) : compteurs et texte', () => {
  const { grouper, map } = group(SAMPLE, { onlySite: 'roblox.com' });
  assert.equal(map.size, 1);
  assert.equal(map.get('roblox.com').text,
    'Thou_miriba:N2Z6PQXg4XLnTSi\nuser2:pass2\nuser3:pass3\n');
  assert.equal(map.get('roblox.com').count, 3); // roblox.com, account.roblox.com, ROBLOX.com
  assert.equal(grouper.site('netflix.com'), null);
  assert.equal(grouper.stats().kept, 3, 'seules les valeurs du site demandé sont gardées');
  assert.equal(grouper.stats().matched, SAMPLE.length, 'les lignes restent comptées');
  assert.equal(grouper.site(NO_SITE), null, 'les lignes sans site sont exclues d’une passe ciblée');
});

test('le texte d’un site est exactement celui de l’onglet Extraire, mode par mode', () => {
  for (const mode of ['last', 'first', 'longest', 'all']) {
    const expected = new Map();
    for (const line of SAMPLE) {
      const value = extract(line, { mode });
      if (value === null || value === '') continue;
      const host = siteFromLine(line);
      const site = host === null ? NO_SITE : normalizeSite(host);
      expected.set(site, (expected.get(site) || '') + value);
    }

    const { map } = group(SAMPLE, { mode });
    assert.deepEqual([...map.keys()].sort(), [...expected.keys()].sort(), 'sites — mode ' + mode);
    for (const [site, text] of expected) {
      assert.equal(map.get(site).text, text, 'valeurs de ' + site + ' — mode ' + mode);
      assert.equal(map.get(site).count, text.split('\n').filter(Boolean).length, 'compteur de ' + site);
    }
  }
});

test('le bucket "(sans site)" est accessible en passe ciblée', () => {
  const { map } = group(SAMPLE, { onlySite: NO_SITE });
  assert.equal(map.size, 1);
  assert.equal(map.get(NO_SITE).text, 'aaa:bbb\n');
});

test('limite de texte : compteurs complets, texte partiel', () => {
  const lines = Array.from({ length: 100 }, (_, i) => 'https://a.com/x:user' + i + ':pass' + i);
  const grouper = createGrouper({ maxTextBytes: 100 });
  grouper.push(lines.join('\n') + '\n');
  grouper.flush();
  const entry = grouper.site('a.com');
  assert.equal(entry.count, 100);
  assert.ok(entry.text.length <= 100, 'texte borné : ' + entry.text.length);
  assert.equal(entry.truncated, true);
  assert.equal(grouper.stats().kept, 100);
});

test('onValue : chaque valeur passe au fil de l’eau, sans stockage', () => {
  const seen = [];
  const grouper = createGrouper({ keepText: false, onValue: (site, value) => seen.push(site + '|' + value) });
  grouper.push(SAMPLE.join('\n') + '\n');
  grouper.flush();
  assert.equal(seen.length, grouper.stats().kept);
  assert.ok(seen.includes('roblox.com|Thou_miriba:N2Z6PQXg4XLnTSi'));
  assert.ok(seen.includes('netflix.com|user1:pass1'));
  assert.equal(grouper.site('roblox.com').text, '', 'aucun texte gardé en mémoire');
});

test('lignes ignorées et statistiques', () => {
  const { grouper } = group(['sans couple ici', 'https://a.com/x:u1:p1', '', '   ']);
  const stats = grouper.stats();
  assert.equal(stats.lines, 4);
  assert.equal(stats.matched, 1);
  assert.equal(stats.skipped, 2); // "sans couple ici" et "   " (les lignes vides ne comptent pas)
  assert.equal(stats.kept, 1);
  assert.equal(stats.bytes, 'u1:p1\n'.length);
});

test('CRLF, accents et découpage en blocs arbitraires', () => {
  const text = [
    'https://www.roblox.com/x:héllo:wörld42',
    'https://NETFLIX.com/a:user1:pass1',
  ].join('\r\n') + '\r\n';
  const bytes = Buffer.from(text, 'utf8');
  for (const size of [1, 3, 17, 512]) {
    const grouper = createGrouper({});
    for (let i = 0; i < bytes.length; i += size) grouper.pushBytes(bytes.subarray(i, i + size));
    grouper.flush();
    assert.equal(grouper.site('roblox.com').text, 'héllo:wörld42\n', 'blocs de ' + size);
    assert.equal(grouper.site('netflix.com').text, 'user1:pass1\n', 'blocs de ' + size);
  }
});

test('gros volume : tout est rangé, rien n’est perdu', () => {
  const sites = ['roblox.com', 'netflix.com', 'spotify.com', 'github.com'];
  const lines = [];
  for (let i = 0; i < 40000; i++) {
    lines.push('https://www.' + sites[i % sites.length] + '/x:user' + i + ':pass' + i);
  }
  const grouper = createGrouper({});
  const chunk = 4096;
  const text = lines.join('\n') + '\n';
  for (let i = 0; i < text.length; i += chunk) grouper.push(text.slice(i, i + chunk));
  grouper.flush();

  assert.equal(grouper.stats().lines, lines.length);
  assert.equal(grouper.sites().size, sites.length);
  let total = 0;
  for (const site of sites) {
    const entry = grouper.site(site);
    assert.equal(entry.count, 10000, site);
    total += entry.count;
    // première et dernière valeur du site présentes
    assert.ok(entry.text.includes('user' + sites.indexOf(site) + ':pass' + sites.indexOf(site) + '\n'));
  }
  assert.equal(total, lines.length);
  assert.equal(grouper.order()[0].count, 10000);
});
