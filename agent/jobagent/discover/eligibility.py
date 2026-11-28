"""Can this user take this job at all? Code checks before any model reads a posting (v3 S1, S2): where the job can be done from,
the pay, the level and the employment type. Each check returns ("ok" | "no" | "unknown", plain-words reason); only "no" drops a
job, and only when the job itself says so. Unknown is kept. Posting text is third-party data, never instructions."""
import re

from .prefilter import levels

ALL = "*"
# country -> other names (lowercase). Codes only where unambiguous; "US", "UK", "UAE", "EU" are matched in capitals only.
COUNTRIES = {
    "United States": ["united states", "united states of america", "u.s.", "u.s.a.", "america"], "Canada": ["canada"],
    "Mexico": ["mexico", "méxico"], "United Kingdom": ["united kingdom", "u.k.", "great britain", "britain", "england", "scotland", "wales", "northern ireland"],
    "Ireland": ["ireland"], "Portugal": ["portugal"], "Spain": ["spain", "españa"], "France": ["france"], "Germany": ["germany", "deutschland"],
    "Netherlands": ["netherlands", "the netherlands", "holland"], "Belgium": ["belgium"], "Switzerland": ["switzerland"], "Austria": ["austria"],
    "Italy": ["italy"], "Poland": ["poland"], "Czechia": ["czechia", "czech republic"], "Romania": ["romania"], "Bulgaria": ["bulgaria"],
    "Hungary": ["hungary"], "Greece": ["greece"], "Sweden": ["sweden"], "Norway": ["norway"], "Denmark": ["denmark"], "Finland": ["finland"],
    "Estonia": ["estonia"], "Latvia": ["latvia"], "Lithuania": ["lithuania"], "Ukraine": ["ukraine"], "Serbia": ["serbia"], "Croatia": ["croatia"],
    "Slovakia": ["slovakia"], "Slovenia": ["slovenia"], "Turkey": ["turkey", "türkiye"], "Israel": ["israel"], "United Arab Emirates": ["united arab emirates", "dubai"],
    "Saudi Arabia": ["saudi arabia"], "Egypt": ["egypt"], "South Africa": ["south africa"], "Nigeria": ["nigeria"], "Kenya": ["kenya"],
    "India": ["india"], "Pakistan": ["pakistan"], "Bangladesh": ["bangladesh"], "Sri Lanka": ["sri lanka"], "China": ["china"], "Japan": ["japan"],
    "South Korea": ["south korea", "korea"], "Taiwan": ["taiwan"], "Hong Kong": ["hong kong"], "Singapore": ["singapore"], "Malaysia": ["malaysia"],
    "Indonesia": ["indonesia"], "Philippines": ["philippines"], "Vietnam": ["vietnam"], "Thailand": ["thailand"], "Australia": ["australia"],
    "New Zealand": ["new zealand"], "Brazil": ["brazil", "brasil"], "Argentina": ["argentina"], "Colombia": ["colombia"], "Chile": ["chile"],
    "Peru": ["peru"], "Uruguay": ["uruguay"], "Ecuador": ["ecuador"], "Costa Rica": ["costa rica"], "Guatemala": ["guatemala"], "Venezuela": ["venezuela"],
}
CODES = {"US": "United States", "USA": "United States", "UK": "United Kingdom", "UAE": "United Arab Emirates", "EU": "eu"}
LATAM = {"Mexico", "Brazil", "Argentina", "Colombia", "Chile", "Peru", "Uruguay", "Ecuador", "Costa Rica", "Guatemala", "Venezuela"}
EUROPE = {"United Kingdom", "Ireland", "Portugal", "Spain", "France", "Germany", "Netherlands", "Belgium", "Switzerland", "Austria", "Italy", "Poland",
          "Czechia", "Romania", "Bulgaria", "Hungary", "Greece", "Sweden", "Norway", "Denmark", "Finland", "Estonia", "Latvia", "Lithuania", "Ukraine",
          "Serbia", "Croatia", "Slovakia", "Slovenia"}
EU = EUROPE - {"United Kingdom", "Switzerland", "Norway", "Ukraine", "Serbia"}
APAC = {"India", "Pakistan", "Bangladesh", "Sri Lanka", "China", "Japan", "South Korea", "Taiwan", "Hong Kong", "Singapore", "Malaysia", "Indonesia",
        "Philippines", "Vietnam", "Thailand", "Australia", "New Zealand"}
NA = {"United States", "Canada", "Mexico"}
REGIONS = {"latam": LATAM, "latin america": LATAM, "south america": LATAM - {"Mexico", "Costa Rica", "Guatemala"}, "emea": EUROPE | {"Turkey", "Israel",
           "United Arab Emirates", "Saudi Arabia", "Egypt", "South Africa", "Nigeria", "Kenya"}, "europe": EUROPE, "european union": EU, "eu": EU,
           "apac": APAC, "asia": APAC - {"Australia", "New Zealand"}, "asia pacific": APAC, "north america": NA, "americas": NA | LATAM,
           "worldwide": {ALL}, "anywhere": {ALL}, "global": {ALL}, "globally": {ALL}, "any location": {ALL}}
US_STATES = {"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
             "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA",
             "WA", "WV", "WI", "WY", "DC"}
CA_PROVINCES = {"AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"}
STATE_NAMES = ("alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|"
               "kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|"
               "new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|"
               "south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia")
PROVINCE_NAMES = "ontario|quebec|québec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island"
_ALIAS = sorted(((a, c) for c, al in COUNTRIES.items() for a in al), key=lambda x: -len(x[0]))  # "south korea" before "korea"
_NAMES = re.compile(r"\b(" + "|".join(re.escape(a) for a, _ in _ALIAS) + r")\b", re.I)
_BY_ALIAS = {a: c for a, c in _ALIAS}
_REGION = re.compile(r"\b(" + "|".join(re.escape(r) for r in sorted(REGIONS, key=len, reverse=True) if r != "eu") + r")\b", re.I)
_CODE = re.compile(r"\b(US|USA|UK|UAE|EU)\b")  # capitals only: "us" is usually the pronoun
_ST = re.compile(r",\s*([A-Z]{2})\b")  # "Austin, TX", "Toronto, ON"
_STATE = re.compile(rf",\s*(?:{STATE_NAMES})\b", re.I)
_PROV = re.compile(rf"\b(?:{PROVINCE_NAMES})\b", re.I)
# Lines where a posting limits who can apply ("must be based in", "open to residents of"). Office lists ("offices in London") are not limits.
LIMIT = re.compile(r"\b(?:must|should|need to|needs to|required to|have to)\s+(?:be\s+)?(?:based|reside|residing|located|living|live)\s+in\b|"
                   r"\b(?:candidates?|applicants?|you)\s+(?:must\s+be\s+|should\s+be\s+)?(?:based|located|residing)\s+in\b|"
                   r"\bopen\s+(?:only\s+)?to\s+(?:candidates|applicants|residents|people|those)\b|\b(?:legally\s+)?(?:eligible|authori[sz]ed)\s+to\s+work\s+in\b|"
                   r"\bresidents?\s+of\b|\bonly\s+(?:hiring|considering|accepting)\b|^\s*(?:job\s+)?locations?\s*:", re.I)


def places(s: str) -> set[str]:
    """Countries a piece of text names (regions expanded; ALL for worldwide)."""
    s = s or ""
    out: set[str] = set()
    if _STATE.search(s) or any(m in US_STATES for m in _ST.findall(s)):
        out.add("United States")
    if _PROV.search(s) or any(m in CA_PROVINCES for m in _ST.findall(s)):
        out.add("Canada")
    rest = re.sub(rf"\b(?:{STATE_NAMES})\b", " ", s, flags=re.I)  # "New Mexico" is not Mexico; "Georgia" here is the state
    out |= {_BY_ALIAS[m.lower()] for m in _NAMES.findall(rest)}
    for m in _REGION.findall(s):
        out |= REGIONS[m.lower()]
    for m in _CODE.findall(s):
        out |= REGIONS["eu"] if m == "EU" else {CODES[m]}
    return out


def user_countries(f: dict) -> set[str]:
    """Where the user can work: settings.filters.country plus the countries of their locations."""
    out = places(str(f.get("country") or ""))
    for p in f.get("locations") or []:
        out |= places(str(p))
    return out - {ALL}


def _place_text(location: str) -> str:
    t = re.sub(r"\(?\b(?:remote|hybrid|fully remote|work from home)\b\)?", " ", location, flags=re.I)
    return re.sub(r"\s+", " ", t.strip(" -–—,/|()")).strip(" -–—,/|") or location


def _names(ps: set[str]) -> str:
    xs = sorted(ps)
    return ", ".join(xs[:3]) + (f" and {len(xs) - 3} more" if len(xs) > 3 else "")


def where(location: str, text: str, users: set[str]) -> tuple[str, str]:
    """`no` only when the job names places and none is the user's, or says applicants must be based somewhere that isn't theirs."""
    if not users:
        return "unknown", "your country is not set"
    loc = location or ""
    lp = places(loc)
    if ALL in lp or lp & users:
        return "ok", ""
    if lp:
        remote = re.search(r"remote|anywhere|work from home", loc, re.I)
        why = (f"Remote, but only for people in {_place_text(loc)}" if remote else f"Only for people in {_place_text(loc)}" if _REGION.search(loc)
               else f"Based in {_place_text(loc)}, outside {_names(users)}")
        return "no", why[:120]
    head = (text or "")[:1500]
    lines = [ln for ln in (text or "").splitlines() if LIMIT.search(ln)] + [ln for ln in head.splitlines() if re.match(r"\s*(?:job\s+)?locations?\s*:", ln, re.I)]
    tp: set[str] = set()
    for ln in lines:
        tp |= places(ln)
    if tp and ALL not in tp and not tp & users:
        return "no", f"Only for people based in {_names(tp)}"[:120]
    return ("ok" if tp else "unknown"), ""


# ---- pay ----

# shortcut: fixed rates from 2026-11 (US dollars per unit), refresh each release. A wrong rate only matters near the user's minimum.
RATES = {"USD": 1.0, "CAD": 0.72, "AUD": 0.65, "NZD": 0.59, "SGD": 0.76, "EUR": 1.08, "GBP": 1.27, "CHF": 1.13, "INR": 0.0118, "BRL": 0.18,
         "MXN": 0.054, "PLN": 0.25, "SEK": 0.094, "NOK": 0.092, "DKK": 0.145, "JPY": 0.0066, "ZAR": 0.055}
SYMBOLS = {"CA$": "CAD", "C$": "CAD", "A$": "AUD", "AU$": "AUD", "NZ$": "NZD", "S$": "SGD", "US$": "USD", "R$": "BRL", "£": "GBP", "€": "EUR", "₹": "INR",
           "¥": "JPY", "$": "$"}
_CUR = r"(?:CA\$|C\$|AU\$|A\$|NZ\$|S\$|US\$|R\$|\$|£|€|₹|¥|\b(?:" + "|".join(RATES) + r")\b)"
_NUM = r"\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?"
_SUF = r"(?:\s?(?:[kKmM]\b|million\b|mil\b|lakhs?\b|lpa\b|L\b))?"
PAY = re.compile(rf"(?P<c1>{_CUR})\s?(?P<a>{_NUM})(?P<sa>{_SUF})(?:\s*(?:-|–|—|to)\s*(?:{_CUR})?\s?(?P<b>{_NUM})(?P<sb>{_SUF}))?"
                 rf"|(?P<a2>{_NUM})(?P<sa2>{_SUF})(?:\s*(?:-|–|—|to)\s*(?P<b2>{_NUM})(?P<sb2>{_SUF}))?\s?(?P<c2>{_CUR})", re.I)
HOUR = re.compile(r"^\W{0,3}(?:/\s?h(?:ou)?r|per\s+hour|an\s+hour|hourly|/hour|p/h|ph\b)", re.I)
MONTH = re.compile(r"^\W{0,3}(?:/\s?mo(?:nth)?|per\s+month|a\s+month|monthly|/m\b|por\s+m[eê]s|/m[eê]s)", re.I)
BEFORE_NOT_PAY = re.compile(r"rais|fund|valuation|revenue|\barr\b|series\s+[a-e]|bonus|budget|stipend|relocation|allowance|reimburs|401|grant|price|cost", re.I)
AFTER_NOT_PAY = re.compile(r"^\W{0,3}(?:in\s+)?(?:funding|valuation|revenue|arr\b|raised|customers|users|signing|sign-on|bonus|stipend|budget|allowance|relocation|grant)", re.I)


def _number(s: str) -> float:
    s = s.strip()
    if re.fullmatch(r"\d{1,3}(?:([.,\s])\d{3})(?:\1\d{3})*", s):
        return float(re.sub(r"[.,\s]", "", s))  # 60.000 / 60,000 / 60 000: thousands
    if re.fullmatch(r"\d{1,3}(?:[.,\s]\d{3})+[.,]\d{1,2}", s):
        return float(re.sub(r"[.,\s]", "", s[:-3]) + "." + s[-2:].lstrip(".,"))
    return float(s.replace(",", "."))


def _scale(suf: str) -> float:
    s = (suf or "").strip().lower()
    return 1e3 if s == "k" else 1e6 if s in ("m", "million", "mil") else 1e5 if s in ("lakh", "lakhs", "lpa", "l") else 1.0


def _code(sym: str, user: str) -> str | None:
    c = SYMBOLS.get(sym, sym.upper())
    if c == "$":
        return user if user in ("USD", "CAD", "AUD", "NZD", "SGD") else "USD"
    return c if c in RATES else None


def pay(text: str, structured: int | None, currency: str) -> int | None:
    """The highest yearly pay a posting quotes, in the user's currency, or None when it quotes none (unknown: kept)."""
    if isinstance(structured, (int, float)) and structured > 0:
        return int(structured)
    best = None
    for m in PAY.finditer(text or ""):
        if BEFORE_NOT_PAY.search(text[max(0, m.start() - 40):m.start()]) or AFTER_NOT_PAY.search(text[m.end():m.end() + 30]):
            continue  # "raised $50M", "$1,000 signing bonus": not pay
        sym = m["c1"] or m["c2"]
        cur = _code(sym, currency)
        if cur is None or (currency not in RATES and cur != currency):
            continue
        a, sa, b, sb = (m["a"], m["sa"], m["b"], m["sb"]) if m["c1"] else (m["a2"], m["sa2"], m["b2"], m["sb2"])
        hi_scale = _scale(sb if b else sa)
        vals = [_number(a) * (_scale(sa) if sa and sa.strip() else hi_scale)] + ([_number(b) * hi_scale] if b else [])
        top = max(vals)
        after = text[m.end():m.end() + 25]
        if HOUR.search(after):
            top *= 2080
        elif MONTH.search(after):
            top *= 12
        elif top < 10_000:
            continue  # a small amount with no "per hour" is not a year's pay
        usd = top * RATES[cur]
        if usd > 1_500_000 or usd < 5_000:
            continue  # funding rounds, prices, typos
        best = max(best or 0, round(top if cur == currency else usd / RATES[currency]))
    return best


def pay_check(top: int | None, f: dict) -> tuple[str, str]:
    lo = f.get("min_salary")
    if not lo or top is None:
        return ("unknown" if top is None else "ok"), ""
    if top < 0.9 * lo:
        cur = f.get("currency", "USD")
        return "no", f"Pay tops out at {_money(top, cur)}, below your {_money(lo, cur)} minimum"
    return "ok", ""


def _money(n: float, cur: str) -> str:
    sym = {"USD": "$", "CAD": "CA$", "AUD": "A$", "GBP": "£", "EUR": "€", "INR": "₹"}.get(cur, f"{cur} ")
    return f"{sym}{round(n / 1000)}k" if n >= 1000 else f"{sym}{int(n)}"


# ---- level and kind ----

JUNIOR = re.compile(r"\b(?:junior|jr\.?|entry[- ]level|intern(?:ship)?|new[- ]grad(?:uate)?|graduate\s+(?:program|scheme)|apprentice(?:ship)?)\b", re.I)
SENIOR_LEVELS = {"senior", "staff", "lead", "manager", "director", "principal"}
FEW_YEARS = re.compile(r"\b[0-2]\s*(?:-|–|to)\s*([1-3])\+?\s*years?\b|\b([1-2])\+?\s*years?\s+(?:of\s+)?(?:relevant\s+|professional\s+|work\s+)?experience", re.I)


def level(title: str, text: str, f: dict) -> tuple[str, str]:
    lvs, years = levels(f.get("experience_level")), f.get("years_experience")
    if lvs <= SENIOR_LEVELS and JUNIOR.search(title or ""):
        return "no", f"A junior role ({JUNIOR.search(title)[0].strip()}); you're aiming for {'/'.join(sorted(lvs))} level"
    if isinstance(years, int) and years >= 7 and FEW_YEARS.search((text or "")[:6000]) and not re.search(r"\b(?:[4-9]|1\d)\+?\s*years?", (text or "")[:6000]):
        return "no", f"Asks for 1 to 3 years of experience; you have {years}"
    return "ok", ""


KINDS = {"full_time": r"full[- ]?time|fulltime|permanent", "part_time": r"part[- ]?time|parttime", "contract": r"contract|contractor|freelance|c2h",
         "internship": r"intern(?:ship)?", "temporary": r"temporary|\btemp\b|seasonal"}
LABEL = {"full_time": "full time", "part_time": "part time", "contract": "a contract", "internship": "an internship", "temporary": "temporary"}


# In a title only when it reads as the job's terms: "(Contract)", "- Contract", "Freelance", "Part-time". "Contract Manager" is a full-time job.
TITLE_KINDS = {"internship": r"\bintern(?:ship)?\b", "contract": r"\(\s*contract(?:or)?\b|[-–|,]\s*contract(?:or)?\s*\)?\s*$|\bcontract[- ]to[- ]hire\b|\bfreelance\b",
               "temporary": r"\btemporary\b|\(\s*temp\b", "part_time": r"\bpart[- ]time\b"}


def _kind_of(s: str, table: dict) -> str | None:
    return next((k for k, rx in table.items() if re.search(rx, s or "", re.I)), None)


def kind(structured: str | None, title: str, job_types: list[str]) -> tuple[str, str]:
    """Lever's commitment, Ashby's employmentType or jobspy's job_type first, then words in the title."""
    order = {k: KINDS[k] for k in ("internship", "contract", "temporary", "part_time", "full_time")}
    k = _kind_of(str(structured or ""), order) or _kind_of(title, TITLE_KINDS)
    if not k or not job_types:
        return ("unknown" if not k else "ok"), ""
    if k in job_types or (k == "temporary" and "contract" in job_types):
        return "ok", ""
    want = " or ".join(LABEL.get(x, x) for x in job_types)
    return "no", f"{LABEL[k][0].upper()}{LABEL[k][1:]} role; you asked for {want}"


REQ = re.compile(r"requir|qualif|must|experience|years|skills|you have|you bring|you.ll need|what we.re looking for|proficien|knowledge of", re.I)


def excerpt(text: str, n: int = 800) -> str:
    """Up to n characters of a posting for the quick sort, the requirement lines first."""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    out = " · ".join([ln for ln in lines if REQ.search(ln)] + [ln for ln in lines if not REQ.search(ln)])
    return out[:n]


def rules(c: dict, body: str, f: dict, users: set[str]) -> tuple[str, str] | None:
    """Everything code decides once the posting text is known (discover poll and the replay bench). Fills in c["salary_max"]."""
    from .boards import AGGREGATORS
    if c.get("salary_max") is None:
        c["salary_max"] = pay(body, None, f.get("currency", "USD"))
    if no := check(c, body, f, users):
        return no
    if c.get("board") in AGGREGATORS and where(c.get("location") or "", body, users)[0] == "unknown":
        return "aggregator", f"Reposted by {c['board']} with no clear location"
    return None


def check(c: dict, text: str, f: dict, users: set[str] | None = None) -> tuple[str, str] | None:
    """The first hard "no" for a candidate as (code, plain reason), or None when it may suit the user."""
    for code, (v, why) in (("where", where(c.get("location") or "", text, user_countries(f) if users is None else users)),
                           ("pay", pay_check(c.get("salary_max"), f)),
                           ("level", level(c.get("title") or "", text, f)),
                           ("kind", kind(c.get("kind"), c.get("title") or "", list(f.get("job_types") or [])))):
        if v == "no":
            return code, why
    return None
