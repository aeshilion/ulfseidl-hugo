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

  python3 tests/formular-probe.py              # muss grün werden
  python3 tests/formular-probe.py --selbsttest # baut Fehler ins HTML ein, MUSS rot werden
Exit 0 = alles wie verlangt, 1 = mindestens ein Fall falsch.
"""
import os, re, subprocess, sys, tempfile, pathlib
from html.parser import HTMLParser

REPO = pathlib.Path(__file__).resolve().parent.parent
THEMEN = ["Schnupperstunde", "Halbtag privat", "Ganztag privat", "Noch offen"]
SPRACHEN = {"de": "", "en": "en/", "nl": "nl/"}
fehler = []


def bauen(ziel, endpoint=None):
    env = dict(os.environ)
    if endpoint:
        env["HUGO_PARAMS_ANFRAGEENDPOINT"] = endpoint
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
    if not mit_formular:
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


def datenschutz_pruefen(html, sprache):
    for muss in ["Turnstile", "30", "Hetzner", "art. 28" if sprache == "nl" else "Art. 28"]:
        pruef(muss in html, f"Datenschutz {sprache}: {muss!r} fehlt")


def lauf(selbsttest=False):
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
        ohne, mit = os.path.join(t, "ohne"), os.path.join(t, "mit")
        bauen(ohne); bauen(mit, "https://form.example.test/contact")
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


if __name__ == "__main__":
    selbst = "--selbsttest" in sys.argv
    lauf(selbst)
    fehler = [x for x in fehler if x]
    if selbst:
        if len(fehler) >= 3 * 3:
            print(f"✓ Selbsttest: {len(fehler)} eingebaute Fehler erkannt (Probe misst)"); sys.exit(0)
        print(f"✕ Selbsttest: nur {len(fehler)} Fehler erkannt — die Probe misst nicht"); print("\n".join(fehler)); sys.exit(1)
    if fehler:
        print("✕ Formular-Probe ROT:"); print("\n".join("  - " + x for x in fehler)); sys.exit(1)
    print("✓ Formular-Probe grün: DE/EN/NL — ohne Endpoint kein Formular; mit Endpoint Felder, Labels, Fehlerzeilen, POST, Honigtopf außen, Themenliste, Turnstile erst bei Berührung, Datenschutz")
