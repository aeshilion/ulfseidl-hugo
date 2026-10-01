#!/usr/bin/env python3
"""Probe ohne Browser für das Anfrageformular (layouts/partials/anfrage-formular.html).

Baut die Seite zweimal (production) und misst am GEBAUTEN HTML:
  1. ohne anfrageEndpoint (Stand im Repo, solange der Dienst nicht läuft): KEIN Formular, keine
     Kontakt-Schaltfläche dorthin — aber Angebotskarten mit data-angebot für angebote_abfragen.
  2. mit Endpoint (HUGO_PARAMS_ANFRAGEENDPOINT): je Sprache genau ein Formular, jedes Feld mit
     <label for>, Fehlerzeile per aria-describedby, method=post (nie GET: sonst stehen Name/Mail/
     Telefon in der Adresszeile), Honigtopf AUSSERHALB des Formulars, Turnstile-Sitekey, die
     Angebots-Werte = THEMEN_LISTE der Instanz (projekt-entwicklung-contact-api/deploy/ulf/env.example).
  3. Datenschutzerklärung in allen drei Sprachen mit Abschnitt Anfrageformular + Turnstile + 30 Tage.
  4. Bedienung nach Alex' Kontaktfeld (integrations.at), statisch am HTML und in jsdom
     (tests/webmcp-lauf.cjs --bedienung, je Sprache): Einwilligung als Schalter (checkbox role=switch),
     „Anfrage senden“ gesperrt bis zur Einwilligung, mit Hinweis; „Anfragen“ auf jeder buchbaren
     Angebotskarte (Link auf #anfrage, Name enthält den sichtbaren Text) wählt das Angebot vor und
     fokussiert die Auswahl; Ablagefläche zum Ziehen nur als Abkürzung (aria-hidden).

  python3 tests/formular-probe.py              # muss grün werden
  python3 tests/formular-probe.py --selbsttest # baut Fehler ins HTML ein, MUSS rot werden
Exit 0 = alles wie verlangt, 1 = mindestens ein Fall falsch.
"""
import glob, json, os, re, shutil, subprocess, sys, tempfile, pathlib
from html.parser import HTMLParser

REPO = pathlib.Path(__file__).resolve().parent.parent
THEMEN = ["Schnupperstunde", "Halbtag privat", "Ganztag privat", "Noch offen"]
SPRACHEN = {"de": "", "en": "en/", "nl": "nl/"}
fehler = []
verfehlt = []   # Selbsttest: Mutationen der Bedienung, die NICHT rot wurden


def bauen(ziel, endpoint=None, ohne_turnstile=False):
    env = dict(os.environ)
    if ohne_turnstile:
        env["HUGO_PARAMS_TURNSTILESITEKEY"] = " "; env["HUGO_PARAMS_ANFRAGEOHNETURNSTILE"] = "true"
    # "ohne" wird ausdrücklich leer gebaut — seit dem Live-Gang steht im Repo ein echter Endpoint.
    env["HUGO_PARAMS_ANFRAGEENDPOINT"] = endpoint or " "
    r = subprocess.run(["hugo", "--minify", "-d", ziel, "--quiet"], cwd=REPO, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr); sys.exit(1)


class Baum(HTMLParser):
    """Sammelt Elemente mit Attributen und merkt sich, ob sie im Formular stehen."""
    def __init__(self):
        super().__init__(); self.el = []; self.in_form = 0; self.forms = []; self.optionen = []; self._sel = None
    def handle_starttag(self, tag, attrs):
        a = dict(attrs); a["_tag"] = tag; a["_imform"] = self.in_form > 0
        if tag == "form": self.in_form += 1; self.forms.append(a)
        if tag == "select": self._sel = a.get("name")
        if tag == "option" and self._sel == "angebot" and a.get("value"): self.optionen.append(a.get("value"))
        self.el.append(a)
    def handle_endtag(self, tag):
        if tag == "form": self.in_form -= 1
        if tag == "select": self._sel = None


def pruef(bed, text):
    if not bed:
        fehler.append(text)


def html_pruefen(html, sprache, mit_formular):
    b = Baum(); b.feed(html)
    karten = [e for e in b.el if e.get("data-angebot")]
    pruef(len(karten) == 4, f"{sprache}: {len(karten)} Angebotskarten mit data-angebot, erwartet 4")
    pruef(all(re.fullmatch(r"\d+", e.get("data-preis-eur") or "") for e in karten), f"{sprache}: data-preis-eur fehlt/keine Zahl")
    anfrage = [f for f in b.forms if f.get("id") == "anfrage-form"]
    knoepfe = [e for e in b.el if e.get("data-anfragen")]
    if not mit_formular:
        pruef(not knoepfe, f"{sprache}: „Anfragen“-Knöpfe ohne Formular")
        pruef(not anfrage, f"{sprache}: Formular ohne Endpoint gebaut")
        pruef('href=#anfrage' not in html and 'href="#anfrage"' not in html, f"{sprache}: Link auf #anfrage ohne Formular")
        return
    pruef(len(anfrage) == 1, f"{sprache}: {len(anfrage)} Anfrageformulare, erwartet 1")
    if not anfrage:
        return
    f = anfrage[0]
    pruef((f.get("method") or "get").lower() == "post", f"{sprache}: Formular ohne method=post (Fallback wäre GET mit Personendaten in der URL)")
    pruef(f.get("data-endpoint", "").endswith("/contact"), f"{sprache}: data-endpoint {f.get('data-endpoint')!r}")
    ids = {e.get("id") for e in b.el if e.get("id")}
    labels_for = {e.get("for") for e in b.el if e["_tag"] == "label" and e.get("for")}
    for e in b.el:
        if e["_tag"] in ("input", "select", "textarea") and e["_imform"]:
            n = e.get("name")
            pruef(e.get("id") in labels_for, f"{sprache}: Feld {n} ohne <label for>")
            if e.get("required") is not None or n in ("email", "phone"):
                desc = (e.get("aria-describedby") or "").split()
                pruef(any(d.endswith("-fehler") and d in ids for d in desc), f"{sprache}: Feld {n} ohne Fehlerzeile per aria-describedby")
    namen = {e.get("name") for e in b.el if e["_imform"]}
    for muss in ["name", "email", "phone", "wunschtermin", "angebot", "personen", "niveau", "message", "consent"]:
        pruef(muss in namen, f"{sprache}: Feld {muss} fehlt")
    hp = [e for e in b.el if e.get("name") == "website"]
    pruef(len(hp) == 1 and not hp[0]["_imform"], f"{sprache}: Honigtopf fehlt oder steht IM Formular")
    pruef(b.optionen == THEMEN, f"{sprache}: Angebots-Werte {b.optionen} ≠ THEMEN_LISTE {THEMEN}")
    pers = re.search(r'<select id=af-personen.*?</select>', html, re.S)
    pruef(pers and re.findall(r'value=(\d)', pers.group(0)) == ["1", "2", "3", "4"], f"{sprache}: Personen nicht 1–4")
    pruef(re.search(r'data-sitekey="?0x[0-9A-Za-z_-]{16,}', html) is not None, f"{sprache}: Turnstile-Sitekey fehlt")
    pruef(re.search(r'<script[^>]+src="?https://challenges\.cloudflare\.com', html) is None, f"{sprache}: Turnstile wird beim Laden geholt (soll erst bei Berührung)")
    pruef(re.search(r'<script src=/js/anfrage\.min\.[0-9a-f]+\.js integrity=', html) is not None, f"{sprache}: anfrage.js nicht eingebunden")
    pruef('role=status' in html and 'aria-live=polite' in html, f"{sprache}: Statuszeile ohne role=status/aria-live")
    bedienung_statisch(b, html, sprache)


def i18n(sprache):
    t = (REPO / "i18n" / f"{sprache}.toml").read_text()
    return dict(re.findall(r'^(\w+) = "(.*)"$', t, re.M))


def bedienung_statisch(b, html, sprache):
    """Schalter, Karten-Knopf, Zurücksetzen, Vollbild am gebauten HTML."""
    c = [e for e in b.el if e.get("id") == "af-consent"]
    pruef(c and c[0].get("type") == "checkbox" and c[0].get("role") == "switch" and "required" in c[0],
          f"{sprache}: Einwilligung nicht als checkbox role=switch required")
    pruef(re.search(r'<label for=af-consent>.*?<a href=[^>]*datenschutz/', html, re.S) is not None, f"{sprache}: Schalter-Label ohne Link zur Datenschutzerklärung")
    sub = [e for e in b.el if e["_tag"] == "button" and e.get("type") == "submit"]
    pruef(sub and "disabled" not in sub[0], f"{sprache}: „Anfrage senden“ schon im HTML gesperrt (ohne Skript nicht bedienbar)")
    pruef(sub and "af-senden-hinweis" in (sub[0].get("aria-describedby") or ""), f"{sprache}: Sperr-Hinweis nicht per aria-describedby am Knopf")
    t = i18n(sprache)
    kn = re.findall(r'<a class="btn karte-anfragen" href=#anfrage data-anfragen=(\w+) aria-label="([^"]+)">([^<]+)</a>', html)
    pruef([k[0] for k in kn] == ["schnupperstunde", "halbtag_privat", "ganztag_privat"], f"{sprache}: „Anfragen“-Knöpfe {[k[0] for k in kn]}")
    for _, aria, sichtbar in kn:
        pruef(sichtbar == t["k_anfragen"] and sichtbar.lower() in aria.lower(), f"{sprache}: Knopf-Name {aria!r} enthält den sichtbaren Text {sichtbar!r} nicht (WCAG 2.5.3)")
    drop = [e for e in b.el if e.get("id") == "af-drop"]
    pruef(drop and drop[0].get("aria-hidden") == "true" and "hidden" in drop[0], f"{sprache}: Ablagefläche nicht aria-hidden/ohne Skript versteckt")


def jsdom_pfad():
    if os.environ.get("JSDOM_NODE_PATH"):
        return os.environ["JSDOM_NODE_PATH"]
    for p in sorted(glob.glob(os.path.expanduser("~/eap/*/node_modules/jsdom/package.json"))):
        return str(pathlib.Path(p).parent.parent)
    return None


def bedienung_laufzeit(wurzel, sprache, js=None):
    np = jsdom_pfad()
    if not np or not shutil.which("node"):
        fehler.append("jsdom/node nicht gefunden (JSDOM_NODE_PATH) — Bedienung nicht prüfbar ist nicht grün"); return
    cmd = ["node", str(REPO / "tests" / "webmcp-lauf.cjs"), str(pathlib.Path(wurzel, SPRACHEN[sprache], "index.html")), str(wurzel), "--bedienung"] + ([f"--js={js}"] if js else [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, NODE_PATH=np), timeout=60)
    except subprocess.TimeoutExpired:
        fehler.append(f"{sprache}: Bedienungslauf hängt"); return
    if r.returncode != 0:
        fehler.append(f"{sprache}: Bedienungslauf Exit {r.returncode}: {r.stderr[:200]}"); return
    b = json.loads(r.stdout)["bedienung"]
    pruef(b.get("schalter_role") == "switch", f"{sprache}: Schalter ohne role=switch")
    pruef(b.get("knopf_anfangs_gesperrt") and b.get("sperrhinweis_anfangs_sichtbar"), f"{sprache}: „Anfrage senden“ ohne Einwilligung nicht gesperrt/ohne Hinweis")
    pruef(b.get("knopf_frei_nach_einwilligung") and b.get("sperrhinweis_danach_weg"), f"{sprache}: Knopf nach Einwilligung nicht frei")
    pruef(b.get("knopf_wieder_gesperrt"), f"{sprache}: Knopf nach Ausschalten nicht wieder gesperrt")
    pruef(b.get("karten_knoepfe") == ["schnupperstunde", "halbtag_privat", "ganztag_privat"], f"{sprache}: Karten-Knöpfe {b.get('karten_knoepfe')}")
    pruef(b.get("karte_waehlt") == "Halbtag privat" and b.get("karte_fokus") == "af-angebot" and b.get("karte_standard_verhindert"),
          f"{sprache}: „Anfragen“ wählt nicht vor/fokussiert nicht ({b.get('karte_waehlt')}, {b.get('karte_fokus')})")
    pruef(not b.get("konsole"), f"{sprache}: Konsolenfehler {b.get('konsole')}")


def datenschutz_pruefen(html, sprache):
    for muss in ["Turnstile", "30", "Hetzner", "art. 28" if sprache == "nl" else "Art. 28"]:
        pruef(muss in html, f"Datenschutz {sprache}: {muss!r} fehlt")


def lauf(selbsttest=False):
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
        ohne, mit, js = os.path.join(t, "ohne"), os.path.join(t, "mit"), os.path.join(t, "js")
        bauen(ohne); bauen(mit, "https://form.example.test/contact")
        bauen(js, "https://form.example.test/contact", ohne_turnstile=True)   # jsdom: Turnstile lädt kein Netz
        for s, pfad in SPRACHEN.items():
            h_ohne = pathlib.Path(ohne, pfad, "index.html").read_text()
            h_mit = pathlib.Path(mit, pfad, "index.html").read_text()
            if selbsttest:
                # drei echte Fehlerbilder: GET-Formular, Honigtopf im Formular, fehlende Fehlerzeile
                h_mit = h_mit.replace("method=post", "method=get", 1)
                h_mit = h_mit.replace("</form>", '<input name=website></form>', 1)
                h_mit = h_mit.replace("aria-describedby=af-name-fehler", "", 1)
            html_pruefen(h_ohne, s, False)
            html_pruefen(h_mit, s, True)
            datenschutz_pruefen(pathlib.Path(mit, pfad, "datenschutz", "index.html").read_text(), s)
            if selbsttest:
                # Bedienung: kaputte Skript-Fassung (Knopf nie gesperrt) muss rot werden
                q = (REPO / "assets" / "js" / "anfrage.js").read_text()
                alt = "knopf.disabled = sendet || !consent.checked;"
                assert alt in q, "Selbsttest-Stelle in anfrage.js fehlt"
                k = pathlib.Path(t, "kaputt.js"); k.write_text(q.replace(alt, "knopf.disabled = sendet;", 1))
                vorher = len(fehler); bedienung_laufzeit(js, s, js=k)
                if len(fehler) == vorher: verfehlt.append(f"{s}: Knopf nie gesperrt")
                alt2 = "a.addEventListener('click', function (e) { if (waehleAngebot("
                assert alt2 in q, "Selbsttest-Stelle 2 in anfrage.js fehlt"
                k.write_text(q.replace(alt2, "a.addEventListener('x-aus', function (e) { if (waehleAngebot(", 1))
                vorher = len(fehler); bedienung_laufzeit(js, s, js=k)
                if len(fehler) == vorher: verfehlt.append(f"{s}: Karten-Knopf ohne Wirkung")
            else:
                bedienung_laufzeit(js, s)


if __name__ == "__main__":
    selbst = "--selbsttest" in sys.argv
    lauf(selbst)
    fehler = [x for x in fehler if x]
    if selbst:
        if verfehlt:
            print(f"✕ Selbsttest: Bedienungs-Mutationen nicht erkannt: {verfehlt}"); sys.exit(1)
        if len(fehler) >= 3 * 3 + 3 + 3:
            print(f"✓ Selbsttest: {len(fehler)} eingebaute Fehler erkannt (Probe misst)"); sys.exit(0)
        print(f"✕ Selbsttest: nur {len(fehler)} Fehler erkannt — die Probe misst nicht"); print("\n".join(fehler)); sys.exit(1)
    if fehler:
        print("✕ Formular-Probe ROT:"); print("\n".join("  - " + x for x in fehler)); sys.exit(1)
    print("✓ Formular-Probe grün: DE/EN/NL — ohne Endpoint kein Formular; mit Endpoint Felder, Labels, Fehlerzeilen, POST, Honigtopf außen, Themenliste, Turnstile erst bei Berührung, Datenschutz, Bedienung (Schalter + Sperre, Karten-Knopf) in jsdom")
