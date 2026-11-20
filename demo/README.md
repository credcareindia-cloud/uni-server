# UniQube demo project: Block A (G+2 staff accommodation)

Marketing demo: 42-room G+2 LGS building with structure, architecture and MEP models, published
through the real Revit publish endpoint, plus tracking data (statuses, history, trailer loads,
QR scans, notifications, dashboard logistics, website requests) as of 20 Nov 2026.

Nothing here is stored in the database dump: rebuild it on any machine in about 2 minutes.

## Rebuild on a new machine

Needs: local stack running (Postgres + MinIO via docker, `npm run dev` for API on :4000 and
frontend on :3000), the seeded admin user (`admin@uniqube.com`), Python 3 with
`pip install ifcopenshell requests numpy`.

```powershell
cd uni-server\demo
python tools\build_demo_ifc.py models        # 3 IFC files + BIMSF/colour sidecars, ~4 s
python -u tools\publish_demo.py              # POST /api/revit/publish, prints the new projectId
cd ..
node demo\seed-demo-tracking.mjs <projectId> # statuses, history, loads, QR, dashboard, requests
```

Open `http://localhost:3000/projects/<projectId>`. Re-running the seed is safe.

## Files

- `tools/build_demo_ifc.py`: the building. Grid, levels, wall lines, openings and every system are
  parameters at the top. Members and pipes are written as absolute triangulated solids because
  the fragments importer instances identical swept solids and loses their placements.
- `tools/publish_demo.py`: uploads like the Revit ribbon (`categories`, `colorMaps`, `bimsfMaps`).
  Args: `[api_url] [email] [password] [projectId]`. Passing a projectId republishes into it.
- `seed-demo-tracking.mjs`: the project timeline (GF installed, L1 mostly installed, L2 in
  production/QC, roof trusses design-approved). Edit `plan()` to move the story.
- `check-webifc.mjs`, `tools/check_geom.py`: geometry checks with web-ifc and IfcOpenShell.

## Video notes

- The viewer culls thin studs when zoomed out (LOD); zoom in for framing shots.
- Sequence button: 564 install steps, Foundation → ELB1001 … → RT-3024.
