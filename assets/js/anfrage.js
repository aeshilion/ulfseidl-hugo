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
 *    - angebote_abfragen (nur lesen): Angebote und Preise aus den Karten der Seite.
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
      el: el, pruefen: pruefen, fehlerZeigen: fehlerZeigen, alleFehlerWeg: alleFehlerWeg, zeige: zeige, tsLaden: tsLaden,
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

  /** Angebote aus den Karten der Seite (Mensch und Agent sehen dieselbe Quelle). */
  function angeboteVonSeite() {
    var karten = document.querySelectorAll('#angebote .card[data-angebot]');
    var out = [];
    for (var i = 0; i < karten.length; i++) {
      var k = karten[i];
      var txt = function (sel) { var x = k.querySelector(sel); return x ? x.textContent.trim() : ''; };
      out.push({
        id: k.getAttribute('data-angebot'),
        name: txt('h3'), dauer: txt('.duration'), preis: txt('.price'),
        preis_eur: Number(k.getAttribute('data-preis-eur')),
        art: k.hasAttribute('data-zuschlag') ? 'Aufpreis je weitere Person' : 'Privatstunde',
        beschreibung: txt('p:last-child')
      });
    }
    return out;
  }

  var NEXT_ANFRAGE = formular ? ['privatstunde_anfragen mit Name, E-Mail oder Telefon, Wunschtermin, Angebot (id), Personen, Koennen und Einwilligung aufrufen; gesendet wird erst, wenn die Person selbst auf den Knopf drueckt.']
    : ['Anfragen direkt telefonisch oder per WhatsApp an ' + (CFG.telefon || '') + '.'];

  var WERKZEUGE = [];

  WERKZEUGE.push({
    name: 'angebote_abfragen',
    title: 'Angebote und Preise abfragen',
    description: 'Liefert die Privatstunden-Angebote von Ulf Seidl (staatlich gepruefter Skilehrer in Flachau, Snow Space Salzburg) mit Dauer und Preis, so wie sie auf ersteschischule.at stehen, dazu den Aufpreis je weiterer Person (bis 4 Personen), die Saison und den direkten Kontakt. Nur lesen, bucht nichts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    ausfuehren: function () {
      var a = angeboteVonSeite();
      if (!a.length) { return Promise.resolve({ error: 'Auf dieser Seite stehen keine Angebote.', recovery: 'Die Startseite ' + location.origin + '/ aufrufen.' }); }
      var note = document.querySelector('#angebote .note');
      return Promise.resolve({
        anbieter: 'Ulf Seidl, Privat-Skilehrer, Flachau (Salzburg, Oesterreich)',
        waehrung: 'EUR',
        angebote: a,
        personen_max: 4,
        hinweis: (note ? note.textContent.trim() + '. ' : '') + 'Preise laut Website; der Aufpreis gilt je weiterer Person auf aehnlichem Niveau.',
        kontakt: { telefon: CFG.telefon, whatsapp: 'https://wa.me/' + (CFG.whatsapp || ''), seite: location.origin + '/' },
        nextSteps: NEXT_ANFRAGE
      });
    }
  });

  if (formular) {
    var ANGEBOTE = [], ANGEBOT_WERT = {};
    Array.prototype.forEach.call(formular.el('angebot').options, function (o) { var id = o.getAttribute('data-id'); if (id) { ANGEBOTE.push(id); ANGEBOT_WERT[id] = o.value; } });
    var NIVEAUS = [], NIVEAU_WERT = {};
    Array.prototype.forEach.call(formular.el('niveau').options, function (o) { var id = o.getAttribute('data-id'); if (id) { NIVEAUS.push(id); NIVEAU_WERT[id] = o.value; } });
    var WARTEZEIT_MS = 10 * 60 * 1000;

    WERKZEUGE.push({
      name: 'privatstunde_anfragen',
      title: 'Privatstunde bei Ulf Seidl anfragen',
      description: 'Bereitet eine Anfrage fuer eine private Skistunde bei Ulf Seidl in Flachau vor: fuellt das Anfrageformular auf ersteschischule.at aus, damit die Person es pruefen kann. GESENDET wird erst, wenn die Person selbst auf "Anfrage senden" drueckt; das Ergebnis dieses Absendens ist die Antwort des Werkzeugs (ok true = Anfrage angekommen, ok false mit error und recovery). Fragen Sie vorher nach dem echten Namen, nach E-Mail-Adresse oder Telefonnummer (mindestens eines), Wunschtermin, Angebot, Personenzahl und Koennen; setzen Sie einwilligung nur auf true, wenn die Person der Datenschutzerklaerung zugestimmt hat, und erfinden Sie keine Angaben. Preise vorher mit angebote_abfragen holen. Es wird nichts verbindlich gebucht; Ulf meldet sich persoenlich.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 120, description: 'Vor- und Nachname der anfragenden Person.' },
          email: { type: 'string', maxLength: 160, description: 'E-Mail-Adresse fuer die Antwort und die Bestaetigung. E-Mail oder telefon, mindestens eines.' },
          telefon: { type: 'string', maxLength: 40, description: 'Telefon- oder WhatsApp-Nummer, nur Ziffern, Leerzeichen und + ( ) / -, mindestens 6 Ziffern. E-Mail oder telefon, mindestens eines.' },
          wunschtermin: { type: 'string', minLength: 2, maxLength: 120, description: 'Wunschtermin oder Zeitraum in eigenen Worten, z. B. "14.-16. Februar 2027, vormittags".' },
          angebot: { type: 'string', enum: ANGEBOTE, description: 'Gewuenschtes Angebot: schnupperstunde (55 min), halbtag_privat (3 h), ganztag_privat (bis 6 h) oder noch_offen.' },
          personen: { type: 'integer', minimum: 1, maximum: 4, description: 'Anzahl der Personen, 1 bis 4 (jede weitere Person mit Aufpreis).' },
          niveau: { type: 'string', enum: NIVEAUS, description: 'Koennen: anfaenger, fortgeschritten oder koenner.' },
          nachricht: { type: 'string', maxLength: 4000, description: 'Optional: Alter der Kinder, Wuensche, Fragen. Nichts erfinden.' },
          einwilligung: { type: 'boolean', description: 'true nur, wenn die Person der Verarbeitung laut Datenschutzerklaerung (' + location.origin + (CFG.datenschutz || '/datenschutz/') + ') zugestimmt hat.' }
        },
        required: ['name', 'wunschtermin', 'angebot', 'personen', 'niveau', 'einwilligung'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false },
      ausfuehren: function (a, client) {
        if (a.einwilligung !== true) {
          return Promise.resolve({ error: 'Ohne Einwilligung in die Datenschutzerklaerung wird keine Anfrage vorbereitet.', recovery: 'Die Person fragen, ob sie zustimmt (Datenschutzerklaerung: ' + location.origin + (CFG.datenschutz || '/datenschutz/') + ').' });
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
        formular.el('consent').checked = true;
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

  WERKZEUGE.forEach(function (w) {
    var tool = {
      name: w.name, title: w.title, description: w.description, inputSchema: w.inputSchema, annotations: w.annotations,
      execute: function (input, client) {
        var g = pruefeSchema(w.inputSchema, input);
        var lauf = g.fehler ? Promise.resolve(g.fehler) : w.ausfuehren(g.args, client);
        return lauf.then(function (out) {
          if (out && out.error) { out.ok = false; if (out.recovery === undefined) { out.recovery = 'Direkt anfragen: Telefon/WhatsApp ' + (CFG.telefon || '') + '.'; } }
          else { out = Object.assign({ ok: true }, out); }
          return ascii(out);
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
