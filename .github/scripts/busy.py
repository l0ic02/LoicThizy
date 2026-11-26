"""Écrit busy.json : créneaux occupés des 75 prochains jours.

Sources : une ou plusieurs adresses iCal (variables d'environnement
ICS_URL = iCloud, GOOGLE_ICS_URL = agenda « RDV Coach », optionnelle).

CONFIDENTIALITÉ : busy.json est public. On n'y écrit QUE des paires
[début, fin] en UTC. Aucun titre, nom, lieu ni description n'est lu.
Les plages qui se chevauchent ou se touchent sont fusionnées.
"""
import os, sys, json, hmac, hashlib, datetime as dt, urllib.request
import icalendar, recurring_ical_events
from zoneinfo import ZoneInfo

PARIS = ZoneInfo('Europe/Paris')
DAYS = 75
OUT = os.environ.get('BUSY_OUT', 'busy.json')
STATE = os.environ.get('MIRROR_MSTATE', '.github/state/mirror-state.json')


def annules(key):
    """RDV annulés depuis iCloud (mémoire du miroir, HMAC seulement) : à retirer du flux Google,
    qui peut garder un RDV annulé pendant des heures."""
    try:
        return {a[0] for a in json.load(open(STATE)).get('annules', [])}
    except Exception:
        return set()


def state_hash(key, uid):
    k = hashlib.sha256(('rdvcoach|' + uid + '|').encode()).hexdigest()[:24]   # même clé que lib/mirror.mjs
    return hmac.new(key.encode(), ('state|' + k).encode(), hashlib.sha256).hexdigest()[:24]


def fetch(url):
    url = url.strip().replace('webcal://', 'https://')
    return urllib.request.urlopen(url, timeout=30).read()


def ranges(raw, start, end, skip=None, rdv_min=None):
    cal = icalendar.Calendar.from_ical(raw)
    recurrents = {str(c.get('UID', '')) for c in cal.walk('VEVENT') if c.get('RRULE') or c.get('RECURRENCE-ID')}
    for ev in recurring_ical_events.of(cal).between(start, end):
        if str(ev.get('TRANSP', '')).upper() == 'TRANSPARENT':
            continue
        if str(ev.get('STATUS', '')).upper() == 'CANCELLED':
            continue
        if skip and str(ev.get('UID', '')) not in recurrents and skip(str(ev.get('UID', ''))):
            continue
        s = ev.get('DTSTART').dt
        e = ev.get('DTEND').dt if ev.get('DTEND') else None
        if isinstance(s, dt.date) and not isinstance(s, dt.datetime):
            e = e or (s + dt.timedelta(days=1))
            s = dt.datetime.combine(s, dt.time(), PARIS)
            e = dt.datetime.combine(e, dt.time(), PARIS)
        else:
            if s.tzinfo is None: s = s.replace(tzinfo=PARIS)
            if e is None: e = s + (ev.get('DURATION').dt if ev.get('DURATION') else dt.timedelta(hours=1))
            if e.tzinfo is None: e = e.replace(tzinfo=PARIS)
        if rdv_min and isinstance(ev.get('DTSTART').dt, dt.datetime):
            e = s + dt.timedelta(minutes=rdv_min)          # RDV du Sheet : 60 min (RDV Coach peut dire 45)
        if e > s:
            yield s.astimezone(dt.timezone.utc), e.astimezone(dt.timezone.utc)


def merge(items):
    out = []
    for s, e in sorted(items):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def main():
    now = dt.datetime.now(PARIS)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + dt.timedelta(days=DAYS)
    items, ok = [], 0
    for name in ('ICS_URL', 'GOOGLE_ICS_URL'):
        url = os.environ.get(name, '').strip()
        if not url:
            continue
        try:
            skip = None
            if name == 'GOOGLE_ICS_URL':
                ann = annules(url)
                skip = (lambda uid, ann=ann, key=url: state_hash(key, uid) in ann) if ann else None
            items += list(ranges(fetch(url), start, end, skip, 60 if name == 'GOOGLE_ICS_URL' else None))
            ok += 1
        except Exception as exc:  # ne jamais afficher l'URL secrète
            print(f'{name} : lecture impossible ({type(exc).__name__})')
            sys.exit(1)  # on garde l'ancien busy.json plutôt qu'un fichier incomplet
    if not ok:
        print('Pas de lien de calendrier configuré')
        return
    fmt = '%Y-%m-%dT%H:%M:%SZ'
    out = [[s.strftime(fmt), e.strftime(fmt)] for s, e in merge(items)]
    new = json.dumps(out, separators=(',', ':'))
    old = open(OUT).read().strip() if os.path.exists(OUT) else ''
    if new != old:
        open(OUT, 'w').write(new)
        print(f'busy.json mis à jour : {len(out)} créneaux occupés ({ok} agenda(s))')
    else:
        print('Aucun changement')


if __name__ == '__main__':
    main()
