/*!
 * Anfrageformular + WebMCP für ersteschischule.at (Ulf Seidl, Privat-Skilehrer in Flachau)
 *
 * 1. Formular (#anfrage-form, partials/anfrage-formular.html): eigene Prüfung mit Meldung NEBEN dem
 *    Feld (aria-invalid + aria-describedby), POST als JSON an die Ulf-Instanz der contact-api.
 *    „Angekommen“ steht NUR bei ok:true — der Server sagt ok:true erst, wenn die Eingangsmail vom
 *    Relay angenommen ist. Sonst: Meldung + zweiter Weg (Telefon/WhatsApp), Angaben bleiben stehen.
 * 2. Turnstile lädt erst bei der ersten Berührung des Formulars (api.js ist groß; Lighthouse).
 * 3. WebMCP über document.modelContext (Rückfall navigator.modelContext), Muster wie
 *    biz-automation eap-webmcp.js: eigene Eingabeprüfung (Chrome prüft enum/unbekannte Parameter
 *    nicht), jede Antwort mit ok, jeder Fehler mit recovery, AbortController auf pagehide.
 *    Werkzeuge und Inhalte kommen aus dem eingebetteten Katalog #ulf-katalog (data/webmcp.yaml +
 *    data/ulf.yaml über layouts/partials/katalog.html) — dieselbe Quelle wie Seite, /webmcp.json, /llms.txt.
 *    - Lesewerkzeuge (list_angebote, get_angebot, get_preise_und_bedingungen, list_faqs, suche_website,
 *      get_treffpunkt_und_anfahrt, get_saison, get_kontakt, list_qualifikationen, get_impressum,
 *      get_datenschutz, list_stimmen nur mit echten Stimmen).
 *    - privatstunde_anfragen: füllt das Formular aus; GESENDET wird erst, wenn der Mensch
 *      „Anfrage senden“ drückt. Das Ergebnis dieses Absendens geht an den Agenten zurück.
 */
(function () {
  'use strict';

  var cfgEl = document.getElementById('anfrage-cfg');
  var CFG = {};
  try { CFG = JSON.parse(cfgEl ? cfgEl.textContent : '{}'); } catch (e) { CFG = {}; }
  var T = CFG.texte || {};
  var f = document.getElementById('anfrage-form');

  // ------------------------------------------------------------ Hilfen
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var TEL_MUSTER = /^[0-9+ ()\/-]{6,40}$/;
  function telefonGut(s) { s = String(s || '').trim(); return TEL_MUSTER.test(s) && (s.match(/[0-9]/g) || []).length >= 6; }
  // wie net/mail auf dem Server: nackte Adresse, ein @, Punkt in der Domain, keine Leerzeichen
  function mailGut(s) { return /^[^@\s<>()",;]+@[^@\s<>()",;]+\.[^@\s<>()",;]{2,}$/.test(String(s || '').trim()); }

  // ------------------------------------------------------------ Formular
  var formular = null;
  if (f && window.fetch) { formular = baueFormular(f); }

  function baueFormular(f) {
    var st = document.getElementById('anfrage-status');
    var knopf = f.querySelector('button[type="submit"]');
    var start = Date.now();
    var wartende = [];          // Agenten-Aufrufe, die auf das Absenden durch den Menschen warten
    var tsBox = f.querySelector('.cf-turnstile'), tsP = null;

    function tsLaden() {
      if (!tsBox) { return Promise.resolve(); }
      if (tsP) { return tsP; }
      tsP = new Promise(function (ok) {
        var s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
        s.async = true; s.onload = ok; s.onerror = ok;
        document.head.appendChild(s);
      });
      return tsP;
    }
    ['focusin', 'pointerdown', 'input'].forEach(function (ev) { f.addEventListener(ev, tsLaden, { once: true, passive: true }); });
    function tsFeld() { return f.querySelector('input[name="cf-turnstile-response"]'); }
    function tsToken() {
      if (!tsBox) { return Promise.resolve(); }
      return tsLaden().then(function () {
        return new Promise(function (ok) {
          var i = 0;
          (function warte() { var x = tsFeld(); if ((x && x.value) || i++ >= 60) { ok(); return; } setTimeout(warte, 250); })();
        });
      });
    }

    function el(n) { return f.elements[n]; }
    function wert(n) { var x = el(n); return x ? String(x.value || '').trim() : ''; }

    // Fehler neben dem Feld
    var FELDER = { name: 'af-name', wunschtermin: 'af-termin', email: 'af-email', phone: 'af-telefon',
                   angebot: 'af-angebot', personen: 'af-personen', niveau: 'af-niveau', consent: 'af-consent', kontakt: null };
    function setzeFehler(feld, text) {
      var id = feld === 'kontakt' ? 'af-kontakt-fehler' : FELDER[feld] + '-fehler';
      var p = document.getElementById(id);
      if (p) { p.textContent = text || ''; p.hidden = !text; }
      var ziele = feld === 'kontakt' ? [el('email'), el('phone')] : [el(feld)];
      ziele.forEach(function (x) { if (x) { if (text) { x.setAttribute('aria-invalid', 'true'); } else { x.removeAttribute('aria-invalid'); } } });
    }
    function alleFehlerWeg() { Object.keys(FELDER).forEach(function (k) { setzeFehler(k, ''); }); }

    /** Prüft wie der Server (und strenger, wo das Formular mehr verlangt). Liefert [{feld, text}]. */
    function pruefen() {
      var fehler = [];
      if (wert('name').length < 2) { fehler.push({ feld: 'name', text: T.e_name }); }
      if (!wert('wunschtermin')) { fehler.push({ feld: 'wunschtermin', text: T.e_termin }); }
      var m = wert('email'), t = wert('phone');
      if (!m && !t) { fehler.push({ feld: 'kontakt', text: T.e_kontakt }); }
      if (m && !mailGut(m)) { fehler.push({ feld: 'email', text: T.e_email }); }
      if (t && !telefonGut(t)) { fehler.push({ feld: 'phone', text: T.e_telefon }); }
      if (!wert('angebot')) { fehler.push({ feld: 'angebot', text: T.e_angebot }); }
      var p = parseInt(wert('personen'), 10);
      if (!(p >= 1 && p <= 4)) { fehler.push({ feld: 'personen', text: T.e_personen }); }
      if (!wert('niveau')) { fehler.push({ feld: 'niveau', text: T.e_niveau }); }
      if (!el('consent').checked) { fehler.push({ feld: 'consent', text: T.e_einwilligung }); }
      return fehler;
    }
    function fehlerZeigen(fehler) {
      alleFehlerWeg();
      fehler.forEach(function (x) { setzeFehler(x.feld, x.text); });
      if (fehler.length) {
        var erstes = fehler[0].feld === 'kontakt' ? el('email') : el(fehler[0].feld);
        if (erstes && typeof erstes.focus === 'function') { erstes.focus(); }
      }
    }
    // Meldung verschwindet, sobald das Feld korrigiert wird
    f.addEventListener('input', function (e) {
      var n = e.target && e.target.name;
      if (n === 'email' || n === 'phone') { setzeFehler('kontakt', ''); }
      if (n && FELDER[n] !== undefined) { setzeFehler(n, ''); }
    });
    f.addEventListener('change', function (e) { var n = e.target && e.target.name; if (n && FELDER[n] !== undefined) { setzeFehler(n, ''); } });

    function zeige(art, html) {
      st.hidden = false;
      st.className = 'af-status af-voll af-' + art;
      st.innerHTML = html;
    }
    function zweiterWeg() {
      return ' ' + esc(T.s_zweiter_weg || '') + ' <a href="tel:' + esc(CFG.telefonUri || '') + '">' + esc(CFG.telefon || '') + '</a> · ' +
        '<a href="https://wa.me/' + esc(CFG.whatsapp || '') + '">WhatsApp</a>';
    }

    function nachricht() {
      var sel = el('angebot'), opt = sel.options[sel.selectedIndex];
      var z = [
        'Wunschtermin: ' + wert('wunschtermin'),
        'Angebot: ' + wert('angebot') + (opt && opt.text && opt.text.indexOf(wert('angebot')) !== 0 ? ' (Seite: ' + opt.text + ')' : ''),
        'Personen: ' + wert('personen'),
        'Koennen: ' + wert('niveau'),
        'Sprache der Seite: ' + (CFG.lang || document.documentElement.lang || '').toUpperCase()
      ];
      var frei = wert('message');
      return z.join('\n') + '\n\nNachricht:\n' + (frei || '—');
    }
    function daten() {
      var hp = document.getElementById('anfrage-hp'), ts = tsFeld();
      return {
        name: wert('name'), email: wert('email'), phone: wert('phone'),
        topic: wert('angebot'), message: nachricht(),
        consent: el('consent').checked === true,
        website: hp ? hp.value : '',
        'cf-turnstile-response': ts ? ts.value : '',
        form_start_ms: start, source_url: location.href
      };
    }

    // Server-Meldung → Feld oder Statuszeile
    var SERVER = {
      'missing fields': { text: 'e_kontakt', feld: 'kontakt' },
      'email or phone required': { text: 'e_kontakt', feld: 'kontakt' },
      'invalid email': { text: 'e_email', feld: 'email' },
      'invalid phone': { text: 'e_telefon', feld: 'phone' },
      'consent required': { text: 'e_einwilligung', feld: 'consent' },
      'too fast': { text: 's_zu_schnell' },
      'turnstile failed': { text: 's_turnstile' },
      'rate limit': { text: 's_limit' }
    };

    function absenden() {
      knopf.disabled = true;
      zeige('laeuft', esc(T.s_sende || '…'));
      return tsToken().then(function () {
        return fetch(f.getAttribute('data-endpoint'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(daten())
        });
      }).then(function (res) {
        return res.text().then(function (roh) {
          var out = {};
          try { out = JSON.parse(roh); } catch (_) { out = { message: roh }; }
          if (res.ok && out.ok === true) {
            zeige('gut', '✓ ' + esc(T.s_ok));
            st.focus();
            return { ok: true, message: T.s_ok };
          }
          var m;
          if (res.ok) {
            m = T.s_gestoert;            // Server hat angenommen, Eingangsmail aber gestört
          } else {
            var s = SERVER[String(out.message || '').trim().toLowerCase()];
            m = s ? T[s.text] : (T.s_abgelehnt + ' (HTTP ' + res.status + ')');
            if (s && s.feld) { fehlerZeigen([{ feld: s.feld, text: m }]); }
          }
          zeige('schlecht', '✕ ' + esc(m) + zweiterWeg());
          if (!(s && s.feld)) { st.focus(); }
          return { ok: false, error: m, recovery: 'Die Angaben stehen noch im Formular. Direkt erreichbar: Telefon/WhatsApp ' + (CFG.telefon || '') + '.' };
        });
      }).catch(function () {
        zeige('schlecht', '✕ ' + esc(T.s_netz) + zweiterWeg());
        st.focus();
        return { ok: false, error: T.s_netz, recovery: 'Die Angaben stehen noch im Formular. Direkt erreichbar: Telefon/WhatsApp ' + (CFG.telefon || '') + '.' };
      }).then(function (r) { knopf.disabled = false; return r; });
    }

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      if (knopf.disabled) { return; }
      var fehler = pruefen();
      if (fehler.length) {
        fehlerZeigen(fehler);
        st.hidden = true;
        return;
      }
      alleFehlerWeg();
      absenden().then(function (r) {
        var w = wartende.splice(0);
        w.forEach(function (fertig) { fertig(r); });
        if (r.ok) {
          // Erst leeren, wenn ein wartender Agent seine Antwort hat.
          setTimeout(function () {
            f.reset(); start = Date.now();
            if (window.turnstile && tsBox) { try { window.turnstile.reset(tsBox); } catch (_) {} }
          }, w.length ? 1500 : 0);
        }
      });
    });

    return {
      el: el, pruefen: pruefen,
      setzeEinwilligung: function (v) { var c = el('consent'); c.checked = v === true; c.dispatchEvent(new Event('change', { bubbles: true })); }, fehlerZeigen: fehlerZeigen, alleFehlerWeg: alleFehlerWeg, zeige: zeige, tsLaden: tsLaden,
      /** Promise auf das nächste Absenden durch den Menschen. */
      warteAufAbsenden: function () { return new Promise(function (ok) { wartende.push(ok); }); },
      knopf: knopf
    };
  }

  // ------------------------------------------------------------ WebMCP
  var ctx = (typeof document !== 'undefined' && document.modelContext) ||
            (typeof navigator !== 'undefined' && navigator.modelContext) || null;
  if (!ctx || typeof ctx.registerTool !== 'function') { return; }

  var abort = new AbortController();
  window.addEventListener('pagehide', function (e) { if (!e.persisted) { try { abort.abort(); } catch (x) {} } });

  // Antworten in ASCII (Chrome hat Werkzeug-Antworten mit Umlauten verstümmelt — Lehre projekt-entwicklung.at).
  function ascii(v) {
    if (typeof v === 'string') {
      return v.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
        .replace(/ß/g, 'ss').replace(/€/g, 'EUR').replace(/[–—]/g, '-').replace(/[„“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...')
        .replace(/·/g, '-').replace(/[^\x00-\x7F]/g, function (c) { return c.normalize ? c.normalize('NFD').replace(/[^\x00-\x7F]/g, '') : ''; });
    }
    if (Array.isArray(v)) { return v.map(ascii); }
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = ascii(v[k]); }); return o; }
    return v;
  }

  function pruefeSchema(schema, input) {
    var a = input == null ? {} : input;
    if (typeof a === 'string') { try { a = JSON.parse(a || '{}'); } catch (e) { return { fehler: { error: 'Parameter muessen ein JSON-Objekt sein.' } }; } }
    if (typeof a !== 'object' || Array.isArray(a)) { return { fehler: { error: 'Parameter muessen ein JSON-Objekt sein.' } }; }
    var props = schema.properties || {}, erlaubt = Object.keys(props);
    var fremd = Object.keys(a).filter(function (k) { return erlaubt.indexOf(k) === -1; });
    if (fremd.length) {
      return { fehler: { error: erlaubt.length ? 'Unbekannte Parameter: ' + fremd.join(', ') + '.' : 'Dieses Werkzeug hat keine Parameter; uebergeben: ' + fremd.join(', ') + '.', validParameters: erlaubt } };
    }
    var fehlt = (schema.required || []).filter(function (k) { return a[k] === undefined || a[k] === null || a[k] === ''; });
    if (fehlt.length) {
      var r = { error: 'Pflichtparameter fehlt: ' + fehlt.join(', ') + '.', validParameters: erlaubt };
      if (props[fehlt[0]].enum) { r.validValues = props[fehlt[0]].enum; }
      return { fehler: r };
    }
    for (var i = 0; i < erlaubt.length; i++) {
      var k = erlaubt[i], p = props[k], v = a[k];
      if (v === undefined || v === null) { continue; }
      if (p.type === 'string' && typeof v !== 'string') { return { fehler: { error: 'Parameter ' + k + ' muss ein Text sein.' } }; }
      if (p.type === 'boolean' && typeof v !== 'boolean') { return { fehler: { error: 'Parameter ' + k + ' muss true oder false sein.' } }; }
      if (p.type === 'integer' && (typeof v !== 'number' || Math.floor(v) !== v)) { return { fehler: { error: 'Parameter ' + k + ' muss eine ganze Zahl sein.' } }; }
      if (p.type === 'integer' && (v < p.minimum || v > p.maximum)) { return { fehler: { error: 'Parameter ' + k + ' muss zwischen ' + p.minimum + ' und ' + p.maximum + ' liegen.' } }; }
      if (p.enum && p.enum.indexOf(v) === -1) { return { fehler: { error: 'Unbekannter Wert fuer ' + k + ': ' + JSON.stringify(v) + '.', validValues: p.enum } }; }
      if (p.type === 'string' && p.maxLength && v.length > p.maxLength) { return { fehler: { error: 'Parameter ' + k + ' ist laenger als ' + p.maxLength + ' Zeichen.' } }; }
      if (p.type === 'string' && p.minLength && v.trim().length < p.minLength) { return { fehler: { error: 'Parameter ' + k + ' braucht mindestens ' + p.minLength + ' Zeichen.' } }; }
    }
    return { args: a };
  }

  // ------------------------------------------------------------ Katalog (data/ulf.yaml + data/webmcp.yaml)
  // Hugo bettet ihn ein (layouts/partials/katalog.html); dieselben Daten bauen /webmcp.json und /llms.txt.
  // Fail-closed: ohne gültigen Katalog wird KEIN Werkzeug angemeldet (lieber keins als ein halber Satz).
  var KAT = null, DEFS = [];
  try {
    var kEl = document.getElementById('ulf-katalog');
    var roh = kEl ? JSON.parse(kEl.textContent) : null;
    if (roh && roh.katalog && Array.isArray(roh.werkzeuge)) { KAT = roh.katalog; DEFS = roh.werkzeuge; }
  } catch (e) { KAT = null; }
  if (!KAT) { console.error('[anfrage-webmcp] Katalog fehlt oder ist kein JSON; keine Werkzeuge angemeldet.'); return; }

  function kopie(o) { return JSON.parse(JSON.stringify(o)); }
  /** Für Suche: klein, ASCII, nur Buchstaben/Ziffern. */
  function norm(s) { return String(ascii(String(s || ''))).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  var SYNONYME = { kost: 'eur', preis: 'eur', teuer: 'eur', euro: 'eur', price: 'eur', geld: 'eur', bezahl: 'zahlung',
                   wann: 'saison', monat: 'saison', wo: 'treffpunkt', treff: 'treffpunkt', ort: 'flachau',
                   kind: 'kinder', sprach: 'deutsch', englisch: 'englisch', gruppe: 'personen', familie: 'personen' };
  /** Suchwörter → Stämme (erste 5 Buchstaben), dazu Synonyme. Wörter unter 3 Zeichen fallen weg. */
  function staemme(q) {
    var out = [];
    norm(q).split(' ').forEach(function (w) {
      if (w.length < 3 && w !== 'wo') { return; }
      out.push(w.slice(0, 5));
      Object.keys(SYNONYME).forEach(function (k) { if (w.indexOf(k) === 0) { out.push(SYNONYME[k].slice(0, 5)); } });
    });
    return out.filter(function (x, i) { return out.indexOf(x) === i; });
  }
  function treffer(text, st) {
    var woerter = norm(text).split(' ');
    return st.filter(function (s) { return woerter.some(function (w) { return w.indexOf(s) === 0; }); }).length;
  }
  function offenHinweis() { return (KAT.offen_bei_ulf && KAT.offen_bei_ulf.hinweis) || ''; }

  var NEXT_ANFRAGE = formular
    ? ['privatstunde_anfragen mit Name, E-Mail oder Telefon, Wunschtermin, Angebot (id), Personen, Koennen und Einwilligung aufrufen; gesendet wird erst, wenn die Person selbst auf den Knopf drueckt.',
       'Oder direkt anrufen bzw. per WhatsApp schreiben: ' + (CFG.telefon || '') + '.']
    : ['Anfragen direkt telefonisch oder per WhatsApp an ' + (CFG.telefon || '') + '.'];

  /** Antwort je Werkzeug. Lesewerkzeuge geben eine KOPIE aus dem Katalog zurück. */
  var LESEN = {
    get_angebot: function (a) {
      var liste = KAT.angebote.angebote, e = null;
      for (var i = 0; i < liste.length; i++) { if (liste[i].id === a.id) { e = liste[i]; } }
      if (!e) { return { error: 'Unbekannte id: ' + JSON.stringify(a.id) + '.', validValues: liste.map(function (x) { return x.id; }) }; }
      return {
        angebot: kopie(e), waehrung: KAT.angebote.waehrung, personen_max: KAT.angebote.personen_max,
        aufpreis_je_weitere_person_eur: KAT.preise_und_bedingungen.aufpreis_je_weitere_person_eur,
        saison: KAT.saison.zeitraum, treffpunkt: KAT.treffpunkt.treffpunkt
      };
    },
    list_faqs: function (a) {
      var alle = KAT.faqs.faqs;
      if (!a.suchbegriff || !String(a.suchbegriff).trim()) { return { anzahl: alle.length, faqs: kopie(alle) }; }
      var st = staemme(a.suchbegriff);
      var hits = alle.filter(function (f) { return treffer(f.frage + ' ' + f.antwort, st) > 0; });
      return { suchbegriff: a.suchbegriff, anzahl: hits.length, faqs: kopie(hits),
               hinweis: hits.length ? undefined : 'Keine passende Frage. Ohne suchbegriff kommen alle ' + alle.length + ' Fragen. ' + offenHinweis() };
    },
    suche_website: function (a) {
      var st = staemme(a.suchbegriff);
      var kandidaten = [];
      KAT.faqs.faqs.forEach(function (f) { kandidaten.push({ bereich: 'Haeufige Frage', titel: f.frage, text: f.antwort, werkzeug: 'list_faqs' }); });
      KAT.angebote.angebote.forEach(function (x) { kandidaten.push({ bereich: 'Angebot', titel: x.name, text: x.dauer + ', ' + x.preis_text + ' (' + x.preis_eur + ' EUR). ' + x.beschreibung, werkzeug: 'get_angebot', id: x.id }); });
      (KAT.preise_und_bedingungen.ablauf || []).forEach(function (t) { kandidaten.push({ bereich: 'Ablauf', titel: 'Ablauf', text: t, werkzeug: 'get_preise_und_bedingungen' }); });
      var r = KAT.preise_und_bedingungen.regeln || {};
      Object.keys(r).forEach(function (k) { kandidaten.push({ bereich: 'Bedingungen', titel: k, text: r[k], werkzeug: 'get_preise_und_bedingungen' }); });
      KAT.qualifikationen.qualifikationen.forEach(function (q) { kandidaten.push({ bereich: 'Qualifikation', titel: q.bezeichnung, text: q.bezeichnung + ' (' + q.nachweis + ')', werkzeug: 'list_qualifikationen' }); });
      kandidaten.push({ bereich: 'Saison', titel: 'Saison', text: 'Saison ' + KAT.saison.zeitraum + '. ' + KAT.saison.kurzfristig, werkzeug: 'get_saison' });
      kandidaten.push({ bereich: 'Treffpunkt', titel: 'Treffpunkt', text: KAT.treffpunkt.treffpunkt + ' (' + KAT.treffpunkt.gebiet.join(', ') + '). ' + KAT.treffpunkt.hinweis, werkzeug: 'get_treffpunkt_und_anfahrt' });
      kandidaten.push({ bereich: 'Kontakt', titel: 'Kontakt', text: 'Telefon und WhatsApp ' + KAT.kontakt.telefon + ', E-Mail ' + KAT.kontakt.email + '. ' + KAT.kontakt.hinweis, werkzeug: 'get_kontakt' });
      var hits = kandidaten.map(function (k) { return { k: k, n: treffer(k.titel + ' ' + k.text, st) }; })
        .filter(function (x) { return x.n > 0; })
        .sort(function (x, y) { return y.n - x.n; })
        .slice(0, 8).map(function (x) { return x.k; });
      var out = { suchbegriff: a.suchbegriff, anzahl: hits.length, treffer: hits };
      if (!hits.length) { out.hinweis = 'Dazu steht nichts auf ersteschischule.at. ' + offenHinweis(); out.offen_bei_ulf = kopie(KAT.offen_bei_ulf.themen); }
      return out;
    }
  };

  var WERKZEUGE = [];
  DEFS.forEach(function (d) {
    if (d.name === 'privatstunde_anfragen') { return; }   // unten, braucht das Formular
    var w = { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations };
    if (LESEN[d.name]) {
      w.ausfuehren = function (a) { var r = LESEN[d.name](a); if (!r.error) { r.nextSteps = NEXT_ANFRAGE; } return Promise.resolve(r); };
    } else if (d.quelle && KAT[d.quelle]) {
      w.ausfuehren = function () { var r = kopie(KAT[d.quelle]); r.nextSteps = NEXT_ANFRAGE; return Promise.resolve(r); };
    } else {
      console.error('[anfrage-webmcp] Werkzeug ohne Quelle im Katalog: ' + d.name);
      return;
    }
    WERKZEUGE.push(w);
  });

  var defAnfrage = null;
  DEFS.forEach(function (d) { if (d.name === 'privatstunde_anfragen') { defAnfrage = d; } });
  if (formular && defAnfrage) {
    // id → Formularwert aus den <option data-id> (gebaut aus derselben data/ulf.yaml)
    var ANGEBOT_WERT = {}, NIVEAU_WERT = {};
    Array.prototype.forEach.call(formular.el('angebot').options, function (o) { var id = o.getAttribute('data-id'); if (id) { ANGEBOT_WERT[id] = o.value; } });
    Array.prototype.forEach.call(formular.el('niveau').options, function (o) { var id = o.getAttribute('data-id'); if (id) { NIVEAU_WERT[id] = o.value; } });
    var WARTEZEIT_MS = 10 * 60 * 1000;

    WERKZEUGE.push({
      name: defAnfrage.name, title: defAnfrage.title, description: defAnfrage.description,
      inputSchema: defAnfrage.inputSchema, annotations: defAnfrage.annotations,
      ausfuehren: function (a, client) {
        if (a.einwilligung !== true) {
          return Promise.resolve({ error: 'Ohne Einwilligung in die Datenschutzerklaerung wird keine Anfrage vorbereitet.', recovery: 'Die Person fragen, ob sie zustimmt (Datenschutzerklaerung: ' + location.origin + (CFG.datenschutz || '/datenschutz/') + ').' });
        }
        if (ANGEBOT_WERT[a.angebot] === undefined || NIVEAU_WERT[a.niveau] === undefined) {
          return Promise.resolve({ error: 'Angebot oder Koennen passt nicht zum Formular auf dieser Seite.', validValues: { angebot: Object.keys(ANGEBOT_WERT), niveau: Object.keys(NIVEAU_WERT) } });
        }
        var email = String(a.email || '').trim(), tel = String(a.telefon || '').trim();
        if (!email && !tel) { return Promise.resolve({ error: 'E-Mail oder telefon fehlt (mindestens eines).', validParameters: ['email', 'telefon'] }); }
        if (email && !mailGut(email)) { return Promise.resolve({ error: 'email ist keine gueltige Adresse: ' + JSON.stringify(email) + '.' }); }
        if (tel && !telefonGut(tel)) { return Promise.resolve({ error: 'telefon braucht mindestens 6 Ziffern, nur 0-9 + ( ) / -: ' + JSON.stringify(tel) + '.' }); }
        var setze = function (n, v) { var x = formular.el(n); x.value = v; x.dispatchEvent(new Event('input', { bubbles: true })); x.dispatchEvent(new Event('change', { bubbles: true })); };
        setze('name', a.name.trim());
        setze('email', email);
        setze('phone', tel);
        setze('wunschtermin', a.wunschtermin.trim());
        setze('angebot', ANGEBOT_WERT[a.angebot]);
        setze('personen', String(a.personen));
        setze('niveau', NIVEAU_WERT[a.niveau]);
        setze('message', String(a.nachricht || ''));
        formular.setzeEinwilligung(true);
        formular.alleFehlerWeg();
        formular.tsLaden();
        var rest = formular.pruefen();
        if (rest.length) {
          formular.fehlerZeigen(rest);
          return Promise.resolve({ error: 'Formular nach dem Ausfuellen nicht vollstaendig: ' + rest.map(function (x) { return x.feld; }).join(', ') + '.' });
        }
        formular.zeige('agent', esc(T.s_agent || ''));
        var sektion = document.getElementById('anfrage');
        if (sektion && sektion.scrollIntoView) { sektion.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        try { formular.knopf.focus({ preventScroll: true }); } catch (_) {}
        var warten = function () {
          return new Promise(function (fertig) {
            var uhr = setTimeout(function () {
              fertig({ error: 'Nicht gesendet: die Person hat innerhalb von 10 Minuten nicht auf "Anfrage senden" gedrueckt.', recovery: 'Die Angaben stehen im Formular; die Person kann jederzeit selbst absenden oder anrufen: ' + (CFG.telefon || '') + '.' });
            }, WARTEZEIT_MS);
            formular.warteAufAbsenden().then(function (r) {
              clearTimeout(uhr);
              fertig(r.ok ? { gesendet: true, message: r.message, hinweis: 'Ulf meldet sich persoenlich; mit E-Mail-Adresse kommt eine Bestaetigung.' } : { error: r.error, recovery: r.recovery });
            });
          });
        };
        // Spezifikation: Warten auf den Menschen über client.requestUserInteraction, wenn vorhanden.
        if (client && typeof client.requestUserInteraction === 'function') {
          return Promise.resolve(client.requestUserInteraction(warten));
        }
        return warten();
      }
    });
  }

  // Erst vollständig bauen, dann anmelden; doppelte Namen = Fehler im Katalog → gar nichts anmelden.
  var namen = WERKZEUGE.map(function (w) { return w.name; });
  if (namen.some(function (n, i) { return namen.indexOf(n) !== i; })) { console.error('[anfrage-webmcp] Werkzeugname doppelt; keine Werkzeuge angemeldet.'); return; }

  WERKZEUGE.forEach(function (w) {
    var tool = {
      name: w.name, title: w.title, description: w.description, inputSchema: w.inputSchema, annotations: w.annotations,
      execute: function (input, client) {
        var g = pruefeSchema(w.inputSchema, input);
        var lauf;
        try { lauf = g.fehler ? Promise.resolve(g.fehler) : w.ausfuehren(g.args, client); } catch (e) { lauf = Promise.reject(e); }
        return lauf.then(function (out) {
          if (out && out.error) { out.ok = false; if (out.recovery === undefined) { out.recovery = 'Direkt anfragen: Telefon/WhatsApp ' + (CFG.telefon || '') + '.'; } }
          else { out = Object.assign({ ok: true }, out); }
          return ascii(JSON.parse(JSON.stringify(out)));
        }, function (e) {
          return ascii({ ok: false, error: 'Fehler: ' + ((e && e.message) || e), recovery: 'Direkt anfragen: Telefon/WhatsApp ' + (CFG.telefon || '') + '.' });
        });
      }
    };
    try {
      var r = ctx.registerTool(tool, { signal: abort.signal });
      if (r && typeof r.catch === 'function') { r.catch(function (e) { console.error('[anfrage-webmcp] Anmeldung abgelehnt: ' + w.name, e); }); }
    } catch (e) {
      console.error('[anfrage-webmcp] Anmeldung abgelehnt: ' + w.name, e);
    }
  });
})();
