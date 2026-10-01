#!/usr/bin/env python3
"""WebMCP-Probe für ersteschischule.at — misst am GEBAUTEN Ergebnis, nicht am Quelltext.

Baut die Seite (production, wie CI) und prüft:
  A. Werkzeuge (eingebetteter Katalog #ulf-katalog je Sprache, /webmcp.json):
     genau die erwarteten Namen; jede Beschreibung ASCII, ≥150 Zeichen, sagt was zurückkommt; jedes
     inputSchema gültig (object, additionalProperties false, required ⊆ properties, enum nicht leer,
     jede Eigenschaft beschrieben); readOnlyHint true außer privatstunde_anfragen; dieselben Definitionen
     in allen Sprachen und in /webmcp.json.
  B. Keine erfundenen Inhalte: jeder Preis auf der Seite (Karten, Formular-Auswahl, JSON-LD) = Preis in
     data/ulf.yaml = Preis im Katalog = Preis in /webmcp.json = Preis in /llms.txt; kein „€ n“ auf der
     Seite, das nicht im Katalog steht; jeder `beleg`/`belege` aus data/ulf.yaml steht wörtlich auf der
     deutschen Startseite bzw. Datenschutzerklärung; kein „TODO“ in Seite, Katalog, webmcp.json, llms.txt;
     list_stimmen nur, wenn data/ulf.yaml echte Stimmen hat; jedes leere TODO-Feld steht als offenes
     Thema in llms.txt.
  C. llms.txt nennt jedes Werkzeug, jede Frage, jeden Preis; JSON-LD ist JSON und trägt die Preise.
  D. Origin-Trial: leer = kein Meta-Tag; gesetzt = genau ein Meta-Tag mit dem rohen Token.
  E. Laufzeit in jsdom (tests/webmcp-lauf.cjs) — einmal über document.modelContext, einmal über den
     Rückfall navigator.modelContext: alle Werkzeuge angemeldet, jeder Lese-Aufruf ok, fremder Parameter
     abgewiesen, pagehide bricht ab, privatstunde_anfragen sendet NICHTS bis zum Klick des Menschen.
     Ohne jsdom ist die Probe ROT („nicht prüfbar“ ist nicht grün).
  Info (kein Tor): Punkte nach eap-infra/pipelines/webmcp-katalog/pruefregel.py, falls vorhanden.

  python3 tests/webmcp-probe.py               # muss grün werden (Exit 0)
  python3 tests/webmcp-probe.py --selbsttest  # baut je Fehlerbild einen Fehler ein; JEDES muss rot werden
jsdom: Umgebungsvariable JSDOM_NODE_PATH (Ordner node_modules) oder Suche unter ~/eap/*/node_modules.
YAML: PyYAML oder /usr/bin/ruby (macOS) liest data/ulf.yaml.
"""
import glob, html as htmlmod, json, os, pathlib, re, shutil, subprocess, sys, tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
SPRACHEN = {"de": "", "en": "en/", "nl": "nl/"}
LESEN = ["list_angebote", "get_angebot", "get_preise_und_bedingungen", "list_faqs", "suche_website",
         "get_treffpunkt_und_anfahrt", "get_saison", "get_kontakt", "list_qualifikationen", "get_impressum",
         "get_datenschutz"]
SCHREIBEN = ["privatstunde_anfragen"]
RUECKGABE = re.compile(r"\b(liefert|listet|gibt .{0,80}zurueck|zurueck)\b", re.I)


# ── Hilfen ────────────────────────────────────────────────────────────────────────────────────
def yaml_laden(p):
    try:
        import yaml  # type: ignore
        return yaml.safe_load(open(p, encoding="utf-8"))
    except ImportError:
        ruby = shutil.which("ruby")
        if not ruby:
            sys.exit("✕ weder PyYAML noch ruby da — data/ulf.yaml nicht lesbar (nicht prüfbar ist nicht grün)")
        r = subprocess.run([ruby, "-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", str(p)],
                           capture_output=True, text=True, check=True)
        return json.loads(r.stdout)


def bauen(ziel, **params):
    env = dict(os.environ)
    for k, v in params.items():
        env["HUGO_PARAMS_" + k.upper()] = v
    r = subprocess.run(["hugo", "--minify", "-d", str(ziel)], cwd=REPO, env=env, capture_output=True, text=True)
    if r.returncode != 0 or re.search(r"\b(WARN|ERROR)\b", r.stdout + r.stderr):
        print(r.stdout + r.stderr)
        sys.exit("✕ hugo --minify nicht sauber (Fehler oder Warnung)")


def lesen(wurzel):
    """Alle geprüften Ausgaben als Texte — Mutationen im Selbsttest wirken auf diese Kopie."""
    w = pathlib.Path(wurzel)
    b = {"wurzel": str(w), "webmcp": (w / "webmcp.json").read_text(), "llms": (w / "llms.txt").read_text(),
         "datenschutz": (w / "datenschutz" / "index.html").read_text()}
    for s, p in SPRACHEN.items():
        b["home_" + s] = (w / p / "index.html").read_text()
    return b


def text_aus_html(h):
    h = re.sub(r"<script.*?</script>", " ", h, flags=re.S)
    h = re.sub(r"<[^>]+>", " ", h)
    return re.sub(r"\s+", " ", htmlmod.unescape(h)).strip()


def eingebettet(h, id_):
    m = re.search(r'<script type=(?:"?)application/(?:ld\+)?json(?:"?)(?: id=' + re.escape(id_) + r')?>(.*?)</script>', h, re.S) \
        if id_ == "ld" else re.search(r"<script type=application/json id=" + re.escape(id_) + r">(.*?)</script>", h, re.S)
    if not m:
        return None
    return json.loads(m.group(1))


def jsonld(h):
    m = re.search(r"<script type=application/ld\+json>(.*?)</script>", h, re.S)
    return json.loads(m.group(1)) if m else None


def blaetter(v):
    if isinstance(v, dict):
        for x in v.values():
            yield from blaetter(x)
    elif isinstance(v, list):
        for x in v:
            yield from blaetter(x)
    else:
        yield v


# ── Prüfungen am gebauten Ergebnis ────────────────────────────────────────────────────────────
def statisch(b, daten, fehler):
    def pruef(bed, text):
        if not bed:
            fehler.append(text)

    erwartet = LESEN + (["list_stimmen"] if daten.get("stimmen") else []) + SCHREIBEN
    angebote = daten["angebote"]
    preis_text = {a["id"]: ("+ " if a.get("zuschlag") else "") + f"€ {a['preis_eur']}" for a in angebote}

    try:
        wj = json.loads(b["webmcp"])
    except ValueError as e:
        fehler.append(f"webmcp.json ist kein JSON: {e}"); return
    wz_json = {w["name"]: w for w in wj.get("webmcp", {}).get("werkzeuge", [])}

    kat_de = None
    for s in SPRACHEN:
        h = b["home_" + s]
        try:
            k = eingebettet(h, "ulf-katalog")
        except ValueError as e:
            fehler.append(f"{s}: #ulf-katalog kein JSON: {e}"); continue
        if not k:
            fehler.append(f"{s}: #ulf-katalog fehlt"); continue
        if s == "de":
            kat_de = k
        namen = [w["name"] for w in k["werkzeuge"]]
        pruef(namen == erwartet, f"{s}: Werkzeuge {namen} ≠ erwartet {erwartet}")
        pruef(namen == list(wz_json), f"{s}: Werkzeuge im Katalog ≠ /webmcp.json {list(wz_json)}")
        for w in k["werkzeuge"]:
            n = w["name"]
            d = w.get("description") or ""
            pruef(re.fullmatch(r"[a-z][a-z_]{2,63}", n) is not None, f"{s}: Werkzeugname {n!r} ungültig")
            pruef(len(d) >= 150, f"{s}/{n}: Beschreibung {len(d)} Zeichen (< 150)")
            pruef(RUECKGABE.search(d) is not None, f"{s}/{n}: Beschreibung sagt nicht, was zurückkommt")
            pruef(d.isascii() and (w.get("title") or "").isascii(), f"{s}/{n}: Beschreibung/Titel nicht ASCII (Chrome verstümmelt Umlaute)")
            pruef("{" not in d, f"{s}/{n}: Platzhalter in der Beschreibung nicht ersetzt")
            sch = w.get("inputSchema") or {}
            props = sch.get("properties")
            pruef(sch.get("type") == "object" and isinstance(props, dict), f"{s}/{n}: inputSchema nicht type object mit properties")
            pruef(sch.get("additionalProperties") is False, f"{s}/{n}: additionalProperties nicht false")
            props = props or {}
            pruef(set(sch.get("required") or []) <= set(props), f"{s}/{n}: required nennt unbekannte Eigenschaften")
            for pk, pv in props.items():
                pruef(isinstance(pv, dict) and pv.get("type") in ("string", "integer", "boolean", "number"), f"{s}/{n}.{pk}: type fehlt/ungültig")
                pruef(len((pv or {}).get("description") or "") >= 10, f"{s}/{n}.{pk}: ohne Beschreibung")
                if "enum" in pv:
                    pruef(isinstance(pv["enum"], list) and pv["enum"] and all(isinstance(x, str) for x in pv["enum"]), f"{s}/{n}.{pk}: enum leer oder kein Platzhalter ersetzt")
            ro = (w.get("annotations") or {}).get("readOnlyHint")
            pruef(ro is (n not in SCHREIBEN), f"{s}/{n}: readOnlyHint {ro!r} falsch")
            j = wz_json.get(n)
            if j:
                pruef(all(j.get(x) == w.get(x) for x in ("description", "inputSchema", "annotations", "title")), f"{s}/{n}: Definition weicht von /webmcp.json ab")
        ga = next((w for w in k["werkzeuge"] if w["name"] == "get_angebot"), None)
        if ga:
            pruef(ga["inputSchema"]["properties"]["id"].get("enum") == [a["id"] for a in angebote], f"{s}: get_angebot enum ≠ ids in data/ulf.yaml")

        # Preise: Karten = Daten
        karten = re.findall(r'<div class=(?:card|"card[^"]*") data-angebot=(\S+?) data-preis-eur=(\d+)[^>]*>.*?<p class=price>([^<]*)</p>', h, re.S)
        pruef([(i, int(p)) for i, p, _ in karten] == [(a["id"], a["preis_eur"]) for a in angebote], f"{s}: Karten {[(i, p) for i, p, _ in karten]} ≠ data/ulf.yaml")
        for i, _, t in karten:
            pruef(htmlmod.unescape(t).strip() == preis_text.get(i), f"{s}: Karte {i} zeigt {t!r}, Daten sagen {preis_text.get(i)!r}")
        # Formular-Auswahl
        for a in angebote:
            if not a.get("zuschlag"):
                pruef(f"{a['name'][s]} · € {a['preis_eur']}" in htmlmod.unescape(h), f"{s}: Formular-Auswahl ohne „{a['name'][s]} · € {a['preis_eur']}“")
        # Jeder sichtbare Euro-Betrag ist ein Katalogpreis
        sichtbar = {int(x) for x in re.findall(r"€\s?(\d+)", text_aus_html(h))}
        pruef(sichtbar <= {a["preis_eur"] for a in angebote}, f"{s}: Euro-Beträge auf der Seite ohne Katalogpreis: {sorted(sichtbar - {a['preis_eur'] for a in angebote})}")
        # JSON-LD
        try:
            ld = jsonld(h)
        except ValueError as e:
            ld = None; fehler.append(f"{s}: JSON-LD kein JSON: {e}")
        if ld:
            pruef(ld.get("@type") == "SportsActivityLocation", f"{s}: JSON-LD @type {ld.get('@type')!r}")
            pruef([o.get("price") for o in ld.get("makesOffer", [])] == [a["preis_eur"] for a in angebote], f"{s}: JSON-LD-Preise ≠ data/ulf.yaml")
            pruef(ld.get("address", {}).get("streetAddress") == daten["anbieter"]["adresse"]["strasse"], f"{s}: JSON-LD-Adresse ≠ data/ulf.yaml")
        else:
            fehler.append(f"{s}: JSON-LD fehlt")
        pruef("TODO" not in h, f"{s}: „TODO“ steht auf der Startseite")

    if kat_de is None:
        return
    K = kat_de["katalog"]
    pruef(json.loads(json.dumps(wj.get("katalog"))) == K, "/webmcp.json-Katalog ≠ eingebetteter Katalog")
    pruef([(a["id"], a["preis_eur"]) for a in K["angebote"]["angebote"]] == [(a["id"], a["preis_eur"]) for a in angebote], "Katalog-Preise ≠ data/ulf.yaml")
    for x in (json.dumps(kat_de), b["webmcp"], b["llms"]):
        pruef("TODO" not in x, "„TODO“ in Katalog, webmcp.json oder llms.txt")
    pruef(not any(v == "" for v in blaetter(K)), "leerer Wert im Katalog (leere TODO-Felder sollen wegfallen)")

    # llms.txt
    L = b["llms"]
    for a in angebote:
        pruef(f"{a['name']['de']}: {a['dauer']['de']}, {preis_text[a['id']]}" in L, f"llms.txt: Preiszeile {a['name']['de']} fehlt oder weicht ab")
    sichtbar_llms = {int(x) for x in re.findall(r"€\s?(\d+)", L)}
    pruef(sichtbar_llms <= {a["preis_eur"] for a in angebote}, f"llms.txt: Euro-Beträge ohne Katalogpreis {sorted(sichtbar_llms)}")
    for n in [w["name"] for w in kat_de["werkzeuge"]]:
        pruef(f"`{n}`" in L, f"llms.txt nennt Werkzeug {n} nicht")
    for f in daten["faqs"]:
        pruef(f"### {f['frage']}" in L, f"llms.txt: Frage fehlt: {f['frage']}")
    offen = [o["thema"] for o in daten["offen_bei_ulf"] if not feld(daten, o["feld"])]
    for t in offen:
        pruef(f"- {t}" in L, f"llms.txt: offenes Thema fehlt: {t}")
    pruef(K["offen_bei_ulf"]["themen"] == offen, "Katalog offen_bei_ulf ≠ leere Felder in data/ulf.yaml")

    # Belege: jede Tatsache ohne Zahl steht wörtlich auf der Seite
    de_text = text_aus_html(b["home_de"])
    ds_text = text_aus_html(b["datenschutz"])
    belege = [q["beleg"] for q in daten["qualifikationen"]] + [x["beleg"] for x in daten["bedingungen"]["ablauf"]] \
        + [daten["saison"]["kurzfristig_beleg"], daten["treffpunkt"]["gebiet_beleg"]] + [y for f in daten["faqs"] for y in f["belege"]]
    for x in belege:
        pruef(re.sub(r"\s+", " ", x) in de_text, f"Beleg nicht auf der deutschen Startseite: {x!r}")
    for x in daten["datenschutz"]:
        pruef(re.sub(r"\s+", " ", x["beleg"]) in ds_text, f"Datenschutz-Beleg nicht in der Erklärung: {x['beleg']!r}")


def feld(daten, pfad):
    v = daten
    for t in pfad.split("."):
        v = (v or {}).get(t)
    return v


def origin_trial(b_leer, b_token, token, fehler):
    pruef = lambda bed, t: fehler.append(t) if not bed else None
    for s in SPRACHEN:
        pruef("origin-trial" not in b_leer["home_" + s], f"{s}: Origin-Trial-Meta trotz leerem Token")
        m = re.findall(r'<meta http-equiv=origin-trial content="?([^">]+)"?>', b_token["home_" + s])
        pruef(len(m) == 1 and htmlmod.unescape(m[0]) == token, f"{s}: Origin-Trial-Meta {m!r} ≠ roher Token")


def jsdom_pfad():
    if os.environ.get("JSDOM_NODE_PATH"):
        return os.environ["JSDOM_NODE_PATH"]
    for p in sorted(glob.glob(os.path.expanduser("~/eap/*/node_modules/jsdom/package.json"))):
        return str(pathlib.Path(p).parent.parent)
    return None


def laufzeit(wurzel, daten, fehler, messung_ziel=None, js=None):
    pruef = lambda bed, t: fehler.append(t) if not bed else None
    np = jsdom_pfad()
    if not np or not shutil.which("node"):
        fehler.append("jsdom/node nicht gefunden (JSDOM_NODE_PATH setzen) — Laufzeit nicht prüfbar ist nicht grün"); return
    erwartet = LESEN + (["list_stimmen"] if daten.get("stimmen") else []) + SCHREIBEN
    for art in ("document", "navigator"):
        cmd = ["node", str(REPO / "tests" / "webmcp-lauf.cjs"), str(pathlib.Path(wurzel) / "index.html"), str(wurzel)] + (["--navigator"] if art == "navigator" else []) + ([f"--js={js}"] if js else [])
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, env=dict(os.environ, NODE_PATH=np), timeout=90)
        except subprocess.TimeoutExpired:
            fehler.append(f"jsdom ({art}): Lauf hängt (> 90 s)"); continue
        if r.returncode != 0:
            fehler.append(f"jsdom ({art}): Exit {r.returncode} {r.stderr[:300]}"); continue
        m = json.loads(r.stdout)
        L = m["lauf"]
        pruef(L["angemeldet"] == erwartet, f"jsdom ({art}): angemeldet {L['angemeldet']} ≠ {erwartet}")
        pruef(L["abgebrochen_nach_pagehide"], f"jsdom ({art}): pagehide bricht die Anmeldung nicht ab")
        pruef(not L["konsole"], f"jsdom ({art}): Konsolenfehler {L['konsole']}")
        for w in m["werkzeuge"]:
            for a in w["aufrufe"]:
                ant = a.get("antwort")
                if a["art"] == "unbekannter_parameter":
                    pruef(isinstance(ant, dict) and ant.get("ok") is False, f"jsdom ({art}): {w['name']} nimmt fremden Parameter an")
                else:
                    pruef(isinstance(ant, dict) and ant.get("ok") is True, f"jsdom ({art}): {w['name']} {a['art']} nicht ok: {str(ant or a.get('ausnahme'))[:200]}")
                    pruef(isinstance(ant, dict) and json.dumps(ant).isascii(), f"jsdom ({art}): {w['name']} Antwort nicht ASCII")
            if w["name"] == "list_angebote" and w["aufrufe"]:
                ant = w["aufrufe"][0].get("antwort") or {}
                pruef([(x.get("id"), x.get("preis_eur")) for x in ant.get("angebote", [])] == [(x["id"], x["preis_eur"]) for x in daten["angebote"]], f"jsdom ({art}): list_angebote-Preise ≠ data/ulf.yaml")
        an = L["anfrage"]
        pruef(an.get("vorhanden"), f"jsdom ({art}): privatstunde_anfragen fehlt")
        if an.get("vorhanden"):
            pruef((an.get("ohne_einwilligung") or {}).get("ok") is False, f"jsdom ({art}): Anfrage ohne Einwilligung nicht abgelehnt")
            pruef((an.get("unbekannt") or {}).get("ok") is False, f"jsdom ({art}): Anfrage mit fremdem Parameter nicht abgelehnt")
            pruef(an.get("fetch_vor_klick") == 0 and an.get("antwort_vor_klick") is None, f"jsdom ({art}): GESENDET ohne Klick des Menschen (fetch {an.get('fetch_vor_klick')})")
            pruef(an.get("formular", {}).get("angebot") == "Halbtag privat" and an.get("formular", {}).get("consent") is True, f"jsdom ({art}): Formular nicht ausgefüllt {an.get('formular')}")
            pruef(an.get("fetch_nach_klick") == 1 and an.get("topic") == "Halbtag privat", f"jsdom ({art}): nach dem Klick nicht genau einmal gesendet")
            pruef((an.get("antwort") or {}).get("gesendet") is True, f"jsdom ({art}): Agent bekommt kein gesendet:true")
        if messung_ziel and art == "document":
            pathlib.Path(messung_ziel).write_text(json.dumps(m))


def punkte(messung):
    p = pathlib.Path(os.path.expanduser("~/eap/eap-infra/pipelines/webmcp-katalog/pruefregel.py"))
    if not p.exists():
        return None
    sys.path.insert(0, str(p.parent))
    try:
        from pruefregel import bewerten  # type: ignore
        return bewerten(json.loads(pathlib.Path(messung).read_text()))
    except Exception as e:  # nur Info
        return {"fehler": str(e)}


# ── Selbsttest: je Fehlerbild eine Mutation, jede muss rot werden ─────────────────────────────
def mutationen(b):
    def ersetze(schl, alt, neu):
        c = dict(b); assert alt in c[schl], (schl, alt); c[schl] = c[schl].replace(alt, neu, 1); return c
    k = eingebettet(b["home_de"], "ulf-katalog")
    kurz = json.loads(json.dumps(k)); kurz["werkzeuge"][2]["description"] = "Preise."
    ohne_ap = json.loads(json.dumps(k)); ohne_ap["werkzeuge"][0]["inputSchema"].pop("additionalProperties")
    roh = re.search(r"<script type=application/json id=ulf-katalog>.*?</script>", b["home_de"], re.S).group(0)
    def katalog(neu):
        c = dict(b); c["home_de"] = b["home_de"].replace(roh, "<script type=application/json id=ulf-katalog>" + json.dumps(neu) + "</script>"); return c
    wj = json.loads(b["webmcp"]); wj["webmcp"]["werkzeuge"].pop(3)
    return {
        "Kartenpreis weicht ab": ersetze("home_de", "<p class=price>€ 195</p>", "<p class=price>€ 190</p>"),
        "erfundener Preis auf der Seite": ersetze("home_en", "</h3>", "</h3><p>from € 59</p>"),
        "Beschreibung zu kurz": katalog(kurz),
        "Schema ohne additionalProperties": katalog(ohne_ap),
        "Werkzeug fehlt in webmcp.json": dict(b, webmcp=json.dumps(wj)),
        "TODO sickert in llms.txt": ersetze("llms", "## Kontakt", "## Kontakt\n- Storno: TODO Ulf"),
        "Preis in llms.txt weicht ab": ersetze("llms", "€ 320", "€ 300"),
        "Beleg fehlt auf der Seite": ersetze("home_de", "seit über drei Jahrzehnten", "seit Jahren"),
        "JSON-LD-Preis weicht ab": ersetze("home_nl", '"price":75', '"price":70'),
    }


def js_mutationen():
    return {
        "sendet ohne Klick": ("return warten();", "formular.knopf.click(); return warten();"),
        "pagehide bricht nicht ab": ("try { abort.abort(); } catch (x) {}", ""),
        "fremde Parameter erlaubt": ("if (fremd.length) {", "if (false) {"),
        "kein Rückfall navigator.modelContext": ("(typeof navigator !== 'undefined' && navigator.modelContext) ||", ""),
    }


def main():
    selbst = "--selbsttest" in sys.argv
    daten = yaml_laden(REPO / "data" / "ulf.yaml")
    token = "AxTEST+/token=="
    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as t:
        t = pathlib.Path(t)
        bauen(t / "prod")                                                              # wie CI
        bauen(t / "js", turnstileSitekey=" ", anfrageOhneTurnstile="true")             # jsdom: kein Turnstile-Netz
        bauen(t / "ot", webmcpOriginTrial=token)
        b, b_ot = lesen(t / "prod"), lesen(t / "ot")

        if not selbst:
            fehler = []
            statisch(b, daten, fehler)
            origin_trial(b, b_ot, token, fehler)
            laufzeit(t / "js", daten, fehler, messung_ziel=t / "messung.json")
            if fehler:
                print("✕ WebMCP-Probe ROT:"); print("\n".join("  - " + x for x in fehler)); return 1
            n = len(eingebettet(b["home_de"], "ulf-katalog")["werkzeuge"])
            print(f"✓ WebMCP-Probe grün: {n} Werkzeuge DE/EN/NL = /webmcp.json, Beschreibungen/Schemas gültig, "
                  f"Preise Seite = Daten = Katalog = llms.txt = JSON-LD, Belege auf der Seite, kein TODO außen, "
                  f"Origin-Trial-Meta, jsdom (document + navigator): angemeldet, Aufrufe ok, pagehide, nichts gesendet ohne Klick")
            p = punkte(t / "messung.json")
            if p and "fehler" not in p:
                print(f"  Info pruefregel {p['regel']}: Katalog {p['katalog']}/100 (wirksam erst mit Origin-Trial-Token) — fehlt: " + "; ".join(p["fehlt"]))
            return 0

        # Selbsttest
        verfehlt = []
        for name, kopie in mutationen(b).items():
            f = []; statisch(kopie, daten, f)
            print(f"  {'✓' if f else '✕'} {name}: {len(f)} Fehler erkannt")
            if not f: verfehlt.append(name)
        f = []; origin_trial(b_ot, b_ot, token, f)
        print(f"  {'✓' if f else '✕'} Origin-Trial-Meta trotz leerem Token: {len(f)} Fehler erkannt")
        if not f: verfehlt.append("origin-trial")
        kaputt = json.loads(json.dumps(daten)); kaputt["stimmen"] = [{"text": "erfunden"}]
        f = []; statisch(b, kaputt, f)
        print(f"  {'✓' if f else '✕'} list_stimmen-Regel (Daten mit Stimmen, Werkzeug fehlt): {len(f)} Fehler erkannt")
        if not f: verfehlt.append("stimmen")
        quelle = (REPO / "assets" / "js" / "anfrage.js").read_text()
        for name, (alt, neu) in js_mutationen().items():
            if alt not in quelle:
                print(f"  ✕ {name}: Stelle in assets/js/anfrage.js nicht gefunden"); verfehlt.append(name); continue
            kaputt_js = t / "kaputt.js"
            kaputt_js.write_text(quelle.replace(alt, neu, 1))
            f = []; laufzeit(t / "js", daten, f, js=kaputt_js)
            print(f"  {'✓' if f else '✕'} {name}: {len(f)} Fehler erkannt")
            if not f: verfehlt.append(name)
        if verfehlt:
            print(f"✕ Selbsttest: {len(verfehlt)} Fehlerbild(er) NICHT erkannt — die Probe misst nicht: {verfehlt}"); return 1
        print("✓ Selbsttest: jedes eingebaute Fehlerbild wurde rot (Probe misst)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
