#!/usr/bin/env node
/*
 * WebMCP-Lauf ohne Browser: lädt eine GEBAUTE Startseite in jsdom, setzt eine modelContext-Attrappe,
 * führt das ausgelieferte Skript (public/js/anfrage.min.*.js) aus und ruft jedes Werkzeug auf.
 * Ausgabe (stdout): eine Messung im Format von eap-infra/pipelines/webmcp-katalog/messen.py
 * ({url, werkzeuge:[{name, description, inputSchema, annotations, aufrufe:[{art, args, antwort}]}]})
 * plus eigene Prüfwerte unter "lauf" (Rückfall navigator.modelContext, pagehide, Anfrage-Ablauf).
 *
 *   node tests/webmcp-lauf.cjs <gebaut>/index.html <gebaut-wurzel> [--navigator] [--js=<skript>]
 * --js ersetzt das ausgelieferte Skript (Selbsttest: absichtlich kaputte Fassung von assets/js/anfrage.js).
 * jsdom wird über NODE_PATH gefunden (tests/webmcp-probe.py sucht es); ohne jsdom Exit 3.
 */
'use strict';
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch (e) { console.error('jsdom fehlt (NODE_PATH)'); process.exit(3); }

const [htmlPfad, wurzel] = process.argv.slice(2);
const ueberNavigator = process.argv.includes('--navigator');
const html = fs.readFileSync(htmlPfad, 'utf8');
const src = (html.match(/<script src=([^ >]+anfrage\.min\.[0-9a-f]+\.js)/) || [])[1];
if (!src) { console.error('anfrage.js nicht eingebunden'); process.exit(2); }
const jsArg = process.argv.find(a => a.startsWith('--js='));
const js = fs.readFileSync(jsArg ? jsArg.slice(5) : path.join(wurzel, src.replace(/^"|"$/g, '')), 'utf8');

const url = 'https://ersteschischule.at/';
const dom = new JSDOM(html.replace(/<script src=[^>]+anfrage\.min[^>]+><\/script>/, ''), { url, runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;

// Attrappe: registerTool sammelt; fetch zählt jeden Aufruf (gesendet wird nur auf Klick des Menschen).
const angemeldet = [];
const signale = [];
const mc = { registerTool(tool, opt) { angemeldet.push(tool); signale.push(opt && opt.signal); } };
if (ueberNavigator) { Object.defineProperty(w.navigator, 'modelContext', { value: mc }); }
else { w.document.modelContext = mc; }
const fetches = [];
w.fetch = (u, o) => { fetches.push({ u, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true}') }); };
w.HTMLElement.prototype.scrollIntoView = function () {};
const konsole = [];
w.console.error = (...a) => konsole.push(a.map(String).join(' '));

w.eval(js);

function plan(t) {
  const s = t.inputSchema || {}, props = s.properties || {}, args = {};
  for (const k of s.required || []) {
    const p = props[k] || {};
    if (p.enum) args[k] = p.enum[0];
    else if (p.type === 'integer') args[k] = p.minimum || 1;
    else if (p.type === 'boolean') args[k] = true;
    else args[k] = /such/.test(k) ? 'Preis' : 'Probe';
  }
  const p = [{ art: 'minimal', args }, { art: 'unbekannter_parameter', args: Object.assign({}, args, { __eap_probe: 1 }) }];
  const mit = Object.assign({}, args);
  for (const [k, v] of Object.entries(props)) if (!(k in mit) && v.enum) mit[k] = v.enum[0];
  if (JSON.stringify(mit) !== JSON.stringify(args)) p.push({ art: 'mit_auswahl', args: mit });
  if (Object.keys(props).some(k => /such/.test(k)) && !s.required) p.push({ art: 'suche', args: { suchbegriff: 'Kinder' } });
  // jede enum-Ausprägung einmal (get_angebot: alle ids)
  for (const [k, v] of Object.entries(props)) if (v.enum && (s.required || []).includes(k)) v.enum.slice(1).forEach(e => p.push({ art: 'enum_' + e, args: Object.assign({}, args, { [k]: e }) }));
  return p;
}

// Jeder Aufruf mit Frist: ein Werkzeug, das auf den Menschen wartet, wo es ablehnen sollte, hängt sonst den Lauf.
const frist = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r({ __frist: ms }), ms))]);

(async () => {
  const werkzeuge = [];
  for (const t of angemeldet) {
    const r = { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, aufrufe: [] };
    if (t.name !== 'privatstunde_anfragen') {
      for (const a of plan(t)) {
        try { r.aufrufe.push({ art: a.art, args: a.args, antwort: await frist(t.execute(a.args, {}), 3000) }); }
        catch (e) { r.aufrufe.push({ art: a.art, args: a.args, ausnahme: String(e) }); }
      }
    }
    werkzeuge.push(r);
  }

  // privatstunde_anfragen: ohne Einwilligung → Fehler; mit → Formular ausgefüllt, NICHTS gesendet,
  // bis der Mensch absendet; danach gesendet:true an den Agenten.
  const anfrage = { vorhanden: false };
  const t = angemeldet.find(x => x.name === 'privatstunde_anfragen');
  if (t) {
    anfrage.vorhanden = true;
    const basis = { name: 'Erika Muster', email: 'erika@example.test', wunschtermin: '14.-16. Februar 2027', angebot: 'halbtag_privat', personen: 2, niveau: 'anfaenger', einwilligung: true };
    anfrage.ohne_einwilligung = await frist(t.execute(Object.assign({}, basis, { einwilligung: false }), {}), 3000);
    anfrage.unbekannt = await frist(t.execute(Object.assign({}, basis, { rabatt: 1 }), {}), 3000);
    let fertig = null;
    const laeuft = t.execute(basis, {}).then(x => { fertig = x; });
    await new Promise(r => setTimeout(r, 50));
    const f = w.document.getElementById('anfrage-form');
    anfrage.formular = { name: f.elements.name.value, angebot: f.elements.angebot.value, personen: f.elements.personen.value, niveau: f.elements.niveau.value, consent: f.elements.consent.checked };
    anfrage.fetch_vor_klick = fetches.length;
    anfrage.antwort_vor_klick = fertig;
    f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));   // der Mensch drückt „Anfrage senden“
    await Promise.race([laeuft, new Promise(r => setTimeout(r, 2000))]);
    anfrage.fetch_nach_klick = fetches.length;
    anfrage.topic = fetches[0] && fetches[0].body.topic;
    anfrage.antwort = fertig;
  }

  // pagehide (nicht persisted) bricht die Anmeldung ab
  const ev = new w.Event('pagehide'); ev.persisted = false;
  w.dispatchEvent(ev);
  const out = {
    url, gemessen: new Date().toISOString().slice(0, 10), werkzeuge, formulare: [], origin_trial: [],
    lauf: { ueber: ueberNavigator ? 'navigator.modelContext' : 'document.modelContext', angemeldet: angemeldet.map(x => x.name),
            abgebrochen_nach_pagehide: signale.length > 0 && signale.every(s => s && s.aborted), konsole, anfrage }
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})();
