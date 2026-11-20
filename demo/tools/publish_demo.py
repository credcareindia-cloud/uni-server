"""
Publish the demo IFC models to a UniQube API exactly as the Revit ribbon does
(POST /api/revit/publish with categories, colour maps and BIMSF maps), then wait for the job.

    python publish_demo.py [api_url] [email] [password] [projectId]

Defaults: http://localhost:4000 admin@uniqube.com admin123, new project.
"""
import json
import sys
import time
from pathlib import Path

import requests

API = (sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:4000').rstrip('/')
EMAIL = sys.argv[2] if len(sys.argv) > 2 else 'admin@uniqube.com'
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else 'admin123'
PROJECT_ID = sys.argv[4] if len(sys.argv) > 4 else None
MODELS = Path(__file__).resolve().parent.parent / 'models'
ORDER = [('BlockA_Structure', 'structure'), ('BlockA_Architecture', 'architecture'), ('BlockA_MEP', 'mep')]

r = requests.post(f'{API}/api/auth/login', json={'email': EMAIL, 'password': PASSWORD}, timeout=30)
r.raise_for_status()
data = r.json()
token = data.get('token') or data.get('accessToken') or (data.get('data') or {}).get('token') or (data.get('data') or {}).get('accessToken')
if not token:
    raise SystemExit(f'No token in login response: {str(data)[:300]}')
headers = {'Authorization': f'Bearer {token}'}

fields = {
    'projectName': 'Hamriyah Staff Accommodation - Block A (G+2)',
    'projectDescription': '42-room G+2 LGS staff accommodation, Hamriyah Freezone. Structure, architecture and MEP published from Revit.',
    'categories': json.dumps([c for _, c in ORDER]),
    'colorMaps': json.dumps([json.loads((MODELS / f'{n}.colors.json').read_text()) for n, _ in ORDER]),
    'bimsfMaps': json.dumps([json.loads((MODELS / f'{n}.bimsf.json').read_text()) for n, _ in ORDER]),
}
if PROJECT_ID:
    fields['projectId'] = str(PROJECT_ID)
files = [(f'file{i}', (f'{n}.ifc', open(MODELS / f'{n}.ifc', 'rb'), 'application/octet-stream')) for i, (n, _) in enumerate(ORDER)]
print('Uploading', ', '.join(f'{n}.ifc' for n, _ in ORDER), 'to', API)
r = requests.post(f'{API}/api/revit/publish', headers=headers, data=fields, files=files, timeout=600)
print(r.status_code, r.text[:400])
r.raise_for_status()
job = r.json().get('jobId') or (r.json().get('data') or {}).get('jobId')
last = None
for _ in range(900):
    s = requests.get(f'{API}/api/revit/publish-status/{job}', headers=headers, timeout=30).json()
    s = s.get('data', s)
    line = f"{s.get('status')} {s.get('progress')}% {s.get('message')}"
    if line != last:
        print(line, flush=True)
        last = line
    if s.get('status') in ('completed', 'failed'):
        print(json.dumps({k: s.get(k) for k in ('projectId', 'projectData', 'remapSummaries', 'error')}, indent=2))
        break
    time.sleep(2)
