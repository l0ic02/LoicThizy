"""Appelle /api/mirror (Vercel) : recopie l'agenda Google « RDV Coach » dans iCloud.

Signature : HMAC-SHA256(clé = GOOGLE_ICS_URL, message = "mirror:" + horodatage).
N'affiche que des compteurs : jamais d'URL ni de nom.
Mémoire anti-renvoi de l'import iCloud -> Sheet : .github/state/import-sent.json
(uniquement des hachages HMAC, impossibles à relier à une personne).
"""
import os, sys, json, time, hmac, hashlib, urllib.request, urllib.error

API = os.environ.get('MIRROR_API', 'https://loicthizy.vercel.app/api/mirror')
STATE = os.environ.get('MIRROR_STATE', '.github/state/import-sent.json')
MSTATE = os.environ.get('MIRROR_MSTATE', '.github/state/mirror-state.json')
key = os.environ.get('GOOGLE_ICS_URL', '').strip()
if not key:
    print('Miroir : GOOGLE_ICS_URL absent, rien à faire')
    sys.exit(0)

try:
    sent = [h for h in json.load(open(STATE)) if isinstance(h, str)]
except Exception:
    sent = []

try:
    mstate = json.load(open(MSTATE))
except Exception:
    mstate = None

ts = str(int(time.time()))
sig = hmac.new(key.encode(), ('mirror:' + ts).encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(API, data=json.dumps({'sent': sent, 'state': mstate}).encode(), method='POST',
                             headers={'content-type': 'application/json', 'x-mirror-ts': ts, 'x-mirror-sig': sig,
                                      'user-agent': 'loicthizy-mirror'})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.loads(r.read())
except urllib.error.HTTPError as e:
    print('Miroir : refusé ou en erreur, code HTTP', e.code)
    sys.exit(1)
except Exception as e:
    print('Miroir : appel impossible (' + type(e).__name__ + ')')
    sys.exit(1)

def counters(d):
    return ' · '.join(f'{k}={v}' for k, v in (d or {}).items() if isinstance(v, (int, bool)))

print('Miroir RDV Coach -> iCloud :', counters(res.get('miroir')))
print('Import iCloud -> Sheet     :', counters(res.get('import')))
new = [h for h in res.get('sent_new') or [] if isinstance(h, str) and len(h) == 32 and all(c in '0123456789abcdef' for c in h)]
if new:
    json.dump(sorted(set(sent + new)), open(STATE, 'w'), indent=0)
    print('Mémoire anti-renvoi :', len(new), 'nouveau(x) hachage(s)')

ns = res.get('state')
if isinstance(ns, dict) and ns != mstate:
    ok = lambda h: isinstance(h, str) and len(h) == 24 and all(c in '0123456789abcdef' for c in h)
    clean = {'v': 1, 'n': int(ns.get('n') or 0),
             'pairs': [p for p in ns.get('pairs') or [] if isinstance(p, list) and len(p) == 2 and ok(p[0]) and ok(p[1])],
             'annules': [p for p in ns.get('annules') or [] if isinstance(p, list) and len(p) == 2 and ok(p[0]) and isinstance(p[1], int)],
             'attente': [p for p in ns.get('attente') or [] if isinstance(p, list) and len(p) == 2 and ok(p[0]) and isinstance(p[1], int)]}
    json.dump(clean, open(MSTATE, 'w'), separators=(',', ':'))
    print('Mémoire du miroir :', len(clean['pairs']), 'paire(s) ·', len(clean['annules']), 'annulée(s) ·', len(clean['attente']), 'en attente')
