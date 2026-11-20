"""
UniQube demo project: G+2 LGS staff accommodation, Hamriyah Freezone (Block A).

Builds three IFC4 models on one grid, the way the Revit publish sends them:
  Structure    LGS wall panels (ELB/LB/NLB), floor truss cassettes (FT), roof trusses (RT),
               strip footings and ground slab (Foundation). Every member carries its BIMSF panel mark.
  Architecture external skin, wall linings, doors, windows, decks, roof, parapet, stair, furniture.
  MEP          HVAC, cold/hot water, drainage, fire protection, cable tray, lighting, power,
               sanitaryware, roof plant. First-fix drops inside walls carry the wall panel mark.

Also writes the publish sidecars (bimsf + colour maps) in the shape uniqube_bimsf_export.py and
uniqube_color_export.py produce. Units: millimetres.
Run: python3 build_demo_ifc.py <outdir>
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import ifcopenshell
import ifcopenshell.guid

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
OUT.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------- grid
BAY = 3600            # room bay
NB = 8                # bay 0 = stair core, bays 1..7 = rooms
L = BAY * NB          # 28 800
DS = 5400             # room depth
CW = 1800             # corridor
D = DS * 2 + CW       # 12 600
FF = 3300             # floor to floor
LEVELS = [0, 3300, 6600]
WALL_H = 2960         # stud wall height; floor cassette 300 + deck 40 above
TRUSS_D = 300
ROOF_TOP = LEVELS[-1] + FF
STUD_W, STUD_D = 41, 89
STOREY_NAMES = ['Ground Floor', 'First Floor', 'Second Floor', 'Roof']
PROJECT = 'Hamriyah Staff Accommodation - Block A (G+2)'
WIN_SILL, WIN_HEAD = 750, 2250
DOOR_H = 2100


def hexc(rgb):
    return '#%02X%02X%02X' % tuple(int(round(c * 255)) for c in rgb)


class Model:
    def __init__(self, discipline, id_base):
        self.discipline = discipline
        self.f = ifcopenshell.file(schema='IFC4')
        f = self.f
        self.next_id = id_base
        units = f.createIfcUnitAssignment([
            f.createIfcSIUnit(None, 'LENGTHUNIT', 'MILLI', 'METRE'),
            f.createIfcSIUnit(None, 'AREAUNIT', None, 'SQUARE_METRE'),
            f.createIfcSIUnit(None, 'VOLUMEUNIT', None, 'CUBIC_METRE'),
            f.createIfcSIUnit(None, 'PLANEANGLEUNIT', None, 'RADIAN'),
        ])
        origin = self.axis((0, 0, 0))
        self.ctx3d = f.createIfcGeometricRepresentationContext(None, 'Model', 3, 1e-5, origin, None)
        self.body = f.createIfcGeometricRepresentationSubContext('Body', 'Model', None, None, None, None, self.ctx3d, None, 'MODEL_VIEW', None)
        self.project = f.createIfcProject(ifcopenshell.guid.new(), None, PROJECT, 'Demo project for UniQube', None, None, None, [self.ctx3d], units)
        site_pl = f.createIfcLocalPlacement(None, origin)
        self.site = f.createIfcSite(ifcopenshell.guid.new(), None, 'Hamriyah Freezone Plot HFZ-A12', None, None, site_pl, None, None, 'ELEMENT', None, None, None, None, None)
        b_pl = f.createIfcLocalPlacement(site_pl, self.axis((0, 0, 0)))
        self.building = f.createIfcBuilding(ifcopenshell.guid.new(), None, 'Block A', 'G+2 LGS staff accommodation, 42 rooms', None, b_pl, None, None, 'ELEMENT', None, None, None)
        f.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, self.project, [self.site])
        f.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, self.site, [self.building])
        self.storeys = []
        for name, z in zip(STOREY_NAMES, LEVELS + [ROOF_TOP]):
            pl = f.createIfcLocalPlacement(b_pl, self.axis((0, 0, float(z))))
            self.storeys.append(f.createIfcBuildingStorey(ifcopenshell.guid.new(), None, name, None, None, pl, None, None, 'ELEMENT', float(z)))
        f.createIfcRelAggregates(ifcopenshell.guid.new(), None, None, None, self.building, self.storeys)
        self.contained = defaultdict(list)
        self.by_material = defaultdict(list)
        self.styles = {}
        self.bimsf = {}          # revit id -> mark
        self.bimsf_guid = {}     # guid -> mark
        self.colors_id = {}
        self.colors_guid = {}
        self.count = 0

    # -- geometry primitives
    def axis(self, p, z=None, x=None):
        f = self.f
        pt = f.createIfcCartesianPoint([float(v) for v in p])
        if z is None:
            return f.createIfcAxis2Placement3D(pt, None, None)
        return f.createIfcAxis2Placement3D(pt, f.createIfcDirection([float(v) for v in z]), f.createIfcDirection([float(v) for v in x]))

    def style(self, name, rgb, transparency=0.0):
        key = (name, tuple(rgb), transparency)
        if key not in self.styles:
            f = self.f
            colour = f.createIfcColourRgb(None, *[float(c) for c in rgb])
            shading = f.createIfcSurfaceStyleRendering(colour, float(transparency), None, None, None, None, None, None, 'NOTDEFINED')
            self.styles[key] = f.createIfcSurfaceStyle(name, 'BOTH', [shading])
        return self.styles[key]

    def frame_between(self, a, b, up_hint=(0, 0, 1)):
        """Local frame for a member from a to b: origin a, Z along the member."""
        ax = [b[i] - a[i] for i in range(3)]
        ln = math.sqrt(sum(c * c for c in ax))
        zdir = [c / ln for c in ax]
        hint = up_hint
        if abs(sum(zdir[i] * hint[i] for i in range(3))) >= 0.99:
            hint = (1, 0, 0)
        if abs(sum(zdir[i] * hint[i] for i in range(3))) >= 0.99:
            hint = (0, 1, 0)
        xd = [hint[1] * zdir[2] - hint[2] * zdir[1], hint[2] * zdir[0] - hint[0] * zdir[2], hint[0] * zdir[1] - hint[1] * zdir[0]]
        xl = math.sqrt(sum(c * c for c in xd))
        return (tuple(a), tuple(zdir), tuple(c / xl for c in xd)), ln

    def solid_between(self, a, b, w, d, up_hint=(0, 0, 1), circle=False, segments=12):
        """Member from a to b as an absolute triangulated solid (IfcTriangulatedFaceSet).
        No shared shapes and no rotated placements, so the fragments importer cannot instance or
        mis-place them. w runs along the frame's X, d along its Y."""
        f = self.f
        (o, zd, xd), ln = self.frame_between(a, b, up_hint)
        yd = (zd[1] * xd[2] - zd[2] * xd[1], zd[2] * xd[0] - zd[0] * xd[2], zd[0] * xd[1] - zd[1] * xd[0])
        if circle:
            ring = [((w / 2) * math.cos(2 * math.pi * k / segments), (w / 2) * math.sin(2 * math.pi * k / segments)) for k in range(segments)]
        else:
            ring = [(-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)]
        n = len(ring)
        pts = []
        for end in (a, b):
            for (u, v) in ring:
                pts.append([float(end[i] + u * xd[i] + v * yd[i]) for i in range(3)])
        tris = []
        for k in range(n):
            k2 = (k + 1) % n
            tris += [[k + 1, k2 + 1, n + k2 + 1], [k + 1, n + k2 + 1, n + k + 1]]
        for k in range(1, n - 1):
            tris.append([1, k + 2, k + 1])
            tris.append([n + 1, n + k + 1, n + k + 2])
        return f.createIfcTriangulatedFaceSet(f.createIfcCartesianPointList3D(pts), None, True, tris, None)

    def box_solid(self, x0, y0, z0, x1, y1, z1):
        x0, x1 = sorted((x0, x1))
        y0, y1 = sorted((y0, y1))
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        f = self.f
        pos2d = f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([0.0, 0.0]), None)
        prof = f.createIfcRectangleProfileDef('AREA', None, pos2d, float(x1 - x0), float(y1 - y0))
        return f.createIfcExtrudedAreaSolid(prof, self.axis((cx, cy, z0)), f.createIfcDirection([0.0, 0.0, 1.0]), float(z1 - z0))

    def styled_rep(self, solids, rgb, material, glass_tr=False):
        f = self.f
        items = []
        for s in solids:
            solid, col = (s if isinstance(s, tuple) else (s, rgb))
            tr = 0.55 if glass_tr and col != rgb else 0.0
            st = self.style(material if col == rgb else f'{material}-{hexc(col)}', col, tr)
            f.createIfcStyledItem(solid, [st], None)
            items.append(solid)
        kinds = {'Tessellation' if it.is_a('IfcTessellatedFaceSet') else 'SweptSolid' for it in items}
        rep = f.createIfcShapeRepresentation(self.body, 'Body', kinds.pop() if len(kinds) == 1 else 'SolidModel', items)
        return f.createIfcProductDefinitionShape(None, None, [rep])

    def add(self, ifc_class, name, storey, solids, material, rgb, *, object_type=None,
            mark=None, label=None, predefined=None, props=None, family='UQ', glass_tr=False, no_color_map=False):
        """Create a product with styled solids, contained in a storey, with Revit-like identity data."""
        f = self.f
        rid = str(self.next_id)
        self.next_id += 1
        guid = ifcopenshell.guid.new()
        otype = object_type or name
        frame = None
        if len(solids) == 1 and isinstance(solids[0], tuple) and len(solids[0]) == 2 and isinstance(solids[0][1], tuple) and len(solids[0][1]) == 3 and isinstance(solids[0][1][0], tuple):
            solids, frame = [solids[0][0]], solids[0][1]
        pl = f.createIfcLocalPlacement(None, self.axis(*frame) if frame else self.axis((0, 0, 0)))
        args = dict(GlobalId=guid, Name=f'{family}:{otype}:{rid}', ObjectType=otype, ObjectPlacement=pl,
                    Representation=self.styled_rep(solids, rgb, material, glass_tr), Tag=rid)
        if predefined:
            args['PredefinedType'] = predefined
        el = f.create_entity(ifc_class, **args)
        self.contained[storey].append(el)
        self.by_material[material].append(el)
        pset = {'Mark': label or mark or '', 'Comments': name}
        if mark:
            pset['BIMSF_Container'] = mark
        if props:
            pset.update(props)
        values = [f.createIfcPropertySingleValue(k, None, f.createIfcLabel(str(v)), None) for k, v in pset.items() if v]
        ps = f.createIfcPropertySet(ifcopenshell.guid.new(), None, 'Identity Data', None, values)
        f.createIfcRelDefinesByProperties(ifcopenshell.guid.new(), None, None, None, [el], ps)
        if mark:
            self.bimsf[rid] = mark
            self.bimsf_guid[guid] = mark
        if not no_color_map:
            # multi-material elements (glazing, beds) keep their IFC styles instead of one flat colour
            self.colors_id[rid] = hexc(rgb)
            self.colors_guid[guid] = hexc(rgb)
        self.count += 1
        return el

    def void(self, host, x0, y0, z0, x1, y1, z1, filler=None):
        f = self.f
        rep = f.createIfcShapeRepresentation(self.body, 'Body', 'SweptSolid', [self.box_solid(x0, y0, z0, x1, y1, z1)])
        op = f.createIfcOpeningElement(ifcopenshell.guid.new(), None, 'Opening', None, None,
                                       f.createIfcLocalPlacement(None, self.axis((0, 0, 0))),
                                       f.createIfcProductDefinitionShape(None, None, [rep]), None, 'OPENING')
        f.createIfcRelVoidsElement(ifcopenshell.guid.new(), None, None, None, host, op)
        if filler is not None:
            f.createIfcRelFillsElement(ifcopenshell.guid.new(), None, None, None, op, filler)

    def write(self, name):
        f = self.f
        for storey, els in self.contained.items():
            f.createIfcRelContainedInSpatialStructure(ifcopenshell.guid.new(), None, None, None, els, storey)
        for mat, els in self.by_material.items():
            f.createIfcRelAssociatesMaterial(ifcopenshell.guid.new(), None, None, None, els, f.createIfcMaterial(mat, None, None))
        path = OUT / f'{name}.ifc'
        f.write(str(path))
        by_panel = defaultdict(list)
        for rid, mark in self.bimsf.items():
            by_panel[mark].append(rid)
        bimsf = {
            'version': 1, 'documentTitle': name, 'count': len(self.bimsf), 'panelCount': len(by_panel),
            'byElementId': self.bimsf, 'byUniqueId': {}, 'byIfcGuid': self.bimsf_guid,
            'byPanel': {k: {'displayName': k, 'bimsf': k, 'count': len(v), 'elementIds': v} for k, v in by_panel.items()},
            'panels': [{'id': k, 'displayName': k, 'bimsf': k, 'count': len(v)} for k, v in sorted(by_panel.items())],
            'elements': [],
        }
        colors = {'version': 1, 'documentTitle': name, 'byElementId': self.colors_id, 'byUniqueId': {}, 'byIfcGuid': self.colors_guid, 'elements': []}
        (OUT / f'{name}.bimsf.json').write_text(json.dumps(bimsf))
        (OUT / f'{name}.colors.json').write_text(json.dumps(colors))
        print(f'{name}: {self.count} elements, {len(by_panel)} BIMSF panels -> {path.name} ({path.stat().st_size // 1024} KB)')


# ---------------------------------------------------------------- shared layout
def room_bays():
    return range(1, NB)


def window_x(bay):           # window in each bay's middle façade panel
    return bay * BAY + 1050, bay * BAY + 2550


def corridor_door_x(bay):
    return bay * BAY + 2100, bay * BAY + 3000


def wall_lines():
    """Every LGS wall line: kind, axis, coordinate, panel splits and openings per level."""
    lines = []
    facade = []
    for bay in range(NB):
        b = bay * BAY
        facade += [(b, b + 900), (b + 900, b + 2700), (b + 2700, b + BAY)]
    for y, side in ((0, 'S'), (D, 'N')):
        lines.append(dict(kind='ELB', axis='x', c=y, panels=facade, side=side,
                          openings=lambda lv: [(*window_x(b), WIN_SILL, WIN_HEAD, 'window') for b in range(NB)]))
    ycuts = [(i * 1800, (i + 1) * 1800) for i in range(7)]
    lines.append(dict(kind='ELB', axis='y', c=0, panels=ycuts, side='W',
                      openings=lambda lv: [(5700, 6900, 0, 2400, 'entrance') if lv == 0 else (5700, 6900, WIN_SILL, WIN_HEAD, 'window')]))
    lines.append(dict(kind='ELB', axis='y', c=L, panels=ycuts, side='E',
                      openings=lambda lv: [(2400, 3300, WIN_SILL, WIN_HEAD, 'window'), (5700, 6900, WIN_SILL, WIN_HEAD, 'window'), (9300, 10200, WIN_SILL, WIN_HEAD, 'window')]))
    corridor = []
    for bay in range(NB):
        b = bay * BAY
        corridor += [(b, b + 1800), (b + 1800, b + BAY)]
    for y, side in ((DS, 'CS'), (DS + CW, 'CN')):
        lines.append(dict(kind='LB', axis='x', c=y, panels=corridor, side=side,
                          openings=lambda lv: [(*corridor_door_x(b), 0, DOOR_H, 'door') for b in range(1, NB)] + [(2100, 3000, 0, DOOR_H, 'door')]))
    for k in range(1, NB):
        cuts = [(0, 1800), (1800, 3600), (3600, DS), (DS + CW, DS + CW + 1800), (DS + CW + 1800, DS + CW + 3600), (DS + CW + 3600, D)]
        lines.append(dict(kind='LB', axis='y', c=k * BAY, panels=cuts, side='P', openings=lambda lv: []))
    for bay in room_bays():
        b = bay * BAY
        lines.append(dict(kind='NLB', axis='x', c=3000, panels=[(b, b + 1800)], side='B', openings=lambda lv: []))
        lines.append(dict(kind='NLB', axis='y', c=b + 1800, panels=[(3000, DS)], side='B',
                          openings=lambda lv: [(3800, 4600, 0, DOOR_H, 'bathdoor')]))
        lines.append(dict(kind='NLB', axis='x', c=D - 3000, panels=[(b, b + 1800)], side='B', openings=lambda lv: []))
        lines.append(dict(kind='NLB', axis='y', c=b + 1800, panels=[(DS + CW, D - 3000)], side='B',
                          openings=lambda lv: [(DS + CW + 800, DS + CW + 1600, 0, DOOR_H, 'bathdoor')]))
    return lines


def pt(axis, c, s, z):
    return (s, c, z) if axis == 'x' else (c, s, z)


# ================================================================ STRUCTURE
def build_structure():
    m = Model('structure', 1_100_000)
    steel = (0.74, 0.77, 0.80)
    truss_col = (0.66, 0.70, 0.74)
    concrete = (0.62, 0.62, 0.60)
    registry = []  # (level, axis, c, s, e, mark) for MEP first-fix tagging
    counters = defaultdict(int)

    def mark_for(kind, lv):
        counters[(kind, lv)] += 1
        n = (lv + 1) * 1000 + counters[(kind, lv)]
        return f'{kind}-{n}' if kind in ('FT', 'RT') else f'{kind}{n}'

    def member(storey, a, b, w, d, mark, otype, up=(0, 0, 1), col=steel, predefined='STUD'):
        m.add('IfcMember', otype, storey, [m.solid_between(a, b, w, d, up_hint=up)], 'Light Gauge Steel G550 Z275', col,
              object_type=otype, mark=mark, predefined=predefined, family='UQ_LGS',
              props={'Section': otype.split(' ')[0], 'Panel': mark})

    def stud(st, axis, c, x, za, zb, mark, otype):
        # flange along the wall, web across it
        member(st, pt(axis, c, x, za), pt(axis, c, x, zb), STUD_W if axis == 'x' else STUD_D, STUD_D if axis == 'x' else STUD_W,
               mark, otype, up=(0, 1, 0) if axis == 'x' else (1, 0, 0))

    def runner(st, axis, c, s, e, z, mark, otype, h=STUD_W, predefined='MEMBER'):
        # horizontal member along the wall; web (89) across the wall, height h
        member(st, pt(axis, c, s, z), pt(axis, c, e, z), STUD_D, h, mark, otype,
               up=(0, 0, 1), predefined=predefined)

    for lv, z0 in enumerate(LEVELS):
        st = m.storeys[lv]
        for line in wall_lines():
            axis, c = line['axis'], line['c']
            ops = line['openings'](lv)
            for (s, e) in line['panels']:
                mark = mark_for(line['kind'], lv)
                registry.append((lv, axis, c, s, e, mark))
                runner(st, axis, c, s, e, z0 + STUD_W / 2, mark, '89T41-1.15 Bottom Track')
                runner(st, axis, c, s, e, z0 + WALL_H - STUD_W / 2, mark, '89T41-1.15 Top Track')
                inside = [o for o in ops if o[0] >= s - 1 and o[1] <= e + 1]
                xs = [s + STUD_W / 2]
                p = s + 600
                while p < e - 100:
                    xs.append(p)
                    p += 600
                xs.append(e - STUD_W / 2)
                for x in xs:
                    if any(o[0] - 60 < x < o[1] + 60 for o in inside):
                        continue
                    stud(st, axis, c, x, z0 + STUD_W, z0 + WALL_H - STUD_W, mark, '89S41-1.15 Stud')
                for (os_, oe, oz0, oz1, _kind) in inside:
                    for jx in (os_ - STUD_W / 2, os_ - STUD_W * 1.5, oe + STUD_W / 2, oe + STUD_W * 1.5):
                        stud(st, axis, c, jx, z0 + STUD_W, z0 + WALL_H - STUD_W, mark, '89S41-1.15 Jamb Stud')
                    runner(st, axis, c, os_ - STUD_W * 2, oe + STUD_W * 2, z0 + oz1 + 75, mark, '89S41-1.15 Box Header', h=150)
                    if oz0 > 0:
                        runner(st, axis, c, os_, oe, z0 + oz0 - STUD_W / 2, mark, '89T41-1.15 Sill Track')
                        q = os_ + 300
                        while q < oe - 150:
                            stud(st, axis, c, q, z0 + STUD_W, z0 + oz0 - STUD_W, mark, '89S41-1.15 Cripple')
                            q += 600
                    q = os_ + 300
                    while q < oe - 150:
                        stud(st, axis, c, q, z0 + oz1 + 150, z0 + WALL_H - STUD_W, mark, '89S41-1.15 Cripple')
                        q += 600
                zn = 1350
                segs = [(s + STUD_W, e - STUD_W)]
                for (os_, oe, oz0, oz1, _k) in inside:
                    if oz0 <= zn <= oz1:
                        nxt = []
                        for a0, b0 in segs:
                            if a0 < os_:
                                nxt.append((a0, min(b0, os_ - STUD_W * 2)))
                            if b0 > oe:
                                nxt.append((max(a0, oe + STUD_W * 2), b0))
                        segs = nxt
                for a0, b0 in segs:
                    if b0 - a0 > 200:
                        runner(st, axis, c, a0, b0, z0 + zn, mark, '89S41-1.15 Nogging')

        deck_kind = 'RT' if lv == len(LEVELS) - 1 else 'FT'
        zb = z0 + WALL_H
        zt = zb + TRUSS_D
        tw = STUD_W
        for bay in range(NB):
            for zone, (y0, y1) in (('S', (0, DS)), ('C', (DS, DS + CW)), ('N', (DS + CW, D))):
                if deck_kind == 'FT' and bay == 0 and zone == 'S':
                    continue  # stair void
                mark = mark_for(deck_kind, lv)
                for k in range(3):
                    x = bay * BAY + 600 + k * 1200
                    span = y1 - y0
                    npan = max(2, round(span / 1350))
                    step = span / npan
                    member(st, (x, y0, zt - tw / 2), (x, y1, zt - tw / 2), tw, tw, mark, f'{deck_kind} Top Chord 89S41', col=truss_col, predefined='CHORD')
                    member(st, (x, y0, zb + tw / 2), (x, y1, zb + tw / 2), tw, tw, mark, f'{deck_kind} Bottom Chord 89S41', col=truss_col, predefined='CHORD')
                    for i in range(npan + 1):
                        yy = min(max(y0 + i * step, y0 + tw / 2), y1 - tw / 2)
                        member(st, (x, yy, zb + tw), (x, yy, zt - tw), tw, tw, mark, f'{deck_kind} Web Vertical 89S41', up=(0, 1, 0), col=truss_col, predefined='MEMBER')
                        if i < npan:
                            ya, yb = y0 + i * step, y0 + (i + 1) * step
                            a, b = ((x, ya, zb + tw), (x, yb, zt - tw)) if i % 2 == 0 else ((x, ya, zt - tw), (x, yb, zb + tw))
                            member(st, a, b, tw, tw, mark, f'{deck_kind} Web Diagonal 89S41', up=(1, 0, 0), col=truss_col, predefined='BRACE')

    gf = m.storeys[0]
    for line in wall_lines():
        if line['kind'] == 'NLB':
            continue
        s0, e0 = line['panels'][0][0], line['panels'][-1][1]
        sol = (m.box_solid(s0 - 300, line['c'] - 300, -650, e0 + 300, line['c'] + 300, -250) if line['axis'] == 'x'
               else m.box_solid(line['c'] - 300, s0 - 300, -650, line['c'] + 300, e0 + 300, -250))
        m.add('IfcFooting', 'Strip Footing 600x400', gf, [sol], 'Concrete C35 OPC', concrete, object_type='Strip Footing 600x400',
              mark='Foundation', predefined='STRIP_FOOTING', family='UQ_Foundation')
    m.add('IfcSlab', 'Ground Bearing Slab 250', gf, [m.box_solid(-150, -150, -250, L + 150, D + 150, 0)], 'Concrete C35 OPC', (0.70, 0.70, 0.68),
          object_type='Ground Bearing Slab 250', mark='Foundation', predefined='BASESLAB', family='UQ_Foundation')
    m.write('BlockA_Structure')
    return registry


# ================================================================ ARCHITECTURE
def build_architecture():
    m = Model('architecture', 1_300_000)
    render = (0.94, 0.92, 0.87)
    accent = (0.97, 0.565, 0.17)   # UniQube orange #F7902C
    dark = (0.22, 0.24, 0.27)
    gyp = (0.95, 0.95, 0.93)
    glass = (0.55, 0.74, 0.86)
    wood = (0.58, 0.40, 0.25)
    SKIN = 30

    def window(st, axis, c, s, e, z0):
        f = 60
        zb, ztop = z0 + WIN_SILL, z0 + WIN_HEAD
        a0, a1 = c - 50, c + 50
        mid = (s + e) / 2
        if axis == 'x':
            sols = [m.box_solid(s, a0, zb, e, a1, zb + f), m.box_solid(s, a0, ztop - f, e, a1, ztop),
                    m.box_solid(s, a0, zb, s + f, a1, ztop), m.box_solid(e - f, a0, zb, e, a1, ztop),
                    m.box_solid(mid - 25, a0, zb, mid + 25, a1, ztop), (m.box_solid(s + f, c - 8, zb + f, e - f, c + 8, ztop - f), glass)]
        else:
            sols = [m.box_solid(a0, s, zb, a1, e, zb + f), m.box_solid(a0, s, ztop - f, a1, e, ztop),
                    m.box_solid(a0, s, zb, a1, s + f, ztop), m.box_solid(a0, e - f, zb, a1, e, ztop),
                    m.box_solid(a0, mid - 25, zb, a1, mid + 25, ztop), (m.box_solid(c - 8, s + f, zb + f, c + 8, e - f, ztop - f), glass)]
        return m.add('IfcWindow', f'Aluminium Window {int(e - s)}x1500', st, sols, 'Aluminium Powder Coated', dark, no_color_map=True,
                     object_type=f'AW-01 Sliding {int(e - s)}x1500 Double Glazed', props={'Glazing': '6+12+6 low-e', 'U-Value': '2.1 W/m2K'},
                     family='UQ_Window', glass_tr=True, predefined='WINDOW')

    def door(st, axis, c, s, e, z0, h, name, otype, leaf, thick=114, fire='NA'):
        t = thick / 2
        fw = 45
        if axis == 'x':
            sols = [m.box_solid(s, c - t, z0, s + fw, c + t, z0 + h), m.box_solid(e - fw, c - t, z0, e, c + t, z0 + h),
                    m.box_solid(s, c - t, z0 + h - fw, e, c + t, z0 + h), (m.box_solid(s + fw, c - 20, z0, e - fw, c + 20, z0 + h - fw), leaf)]
        else:
            sols = [m.box_solid(c - t, s, z0, c + t, s + fw, z0 + h), m.box_solid(c - t, e - fw, z0, c + t, e, z0 + h),
                    m.box_solid(c - t, s, z0 + h - fw, c + t, e, z0 + h), (m.box_solid(c - 20, s + fw, z0, c + 20, e - fw, z0 + h - fw), leaf)]
        return m.add('IfcDoor', name, st, sols, 'Door Frame Aluminium', dark, object_type=otype, no_color_map=True, props={'Fire Rating': fire},
                     family='UQ_Door', glass_tr=leaf == glass, predefined='DOOR')

    for lv, z0 in enumerate(LEVELS):
        st = m.storeys[lv]
        for line in wall_lines():
            axis, c, kind, side = line['axis'], line['c'], line['kind'], line['side']
            s0, e0 = line['panels'][0][0], line['panels'][-1][1]
            ops = line['openings'](lv)
            if kind == 'ELB':
                inward = 1 if side in ('S', 'W') else -1
                lo, hi = sorted((c - inward * STUD_D / 2, c + inward * (STUD_D / 2 + 12.5)))
            else:
                lo, hi = c - 57, c + 57
            name = {'ELB': 'External Wall - LGS 89 + Rockwool 89 + GB 12.5 FR',
                    'LB': 'Internal Wall - LGS 89 + 2x GB 12.5 FR',
                    'NLB': 'Bathroom Wall - LGS 89 + GB 12.5 MR + Cement Board 12'}[kind]
            sol = m.box_solid(s0, lo, z0, e0, hi, z0 + WALL_H) if axis == 'x' else m.box_solid(lo, s0, z0, hi, e0, z0 + WALL_H)
            w = m.add('IfcWall', name, st, [sol], 'Gypsum Board 12.5 FR', gyp, object_type=name, predefined='STANDARD',
                      props={'Fire Rating': '30 min' if kind == 'NLB' else '60 min', 'Acoustic Rating': 'Rw 45' if kind == 'LB' else 'Rw 40'},
                      family='UQ_Wall')
            for (os_, oe, oz0, oz1, _k) in ops:
                m.void(w, *((os_, lo - 5, z0 + oz0, oe, hi + 5, z0 + oz1) if axis == 'x' else (lo - 5, os_, z0 + oz0, hi + 5, oe, z0 + oz1)))
            if kind == 'ELB':
                out = -1 if side in ('S', 'W') else 1
                face = c + out * STUD_D / 2
                k0, k1 = sorted((face, face + out * SKIN))
                segments = [(0, BAY), (BAY, L)] if side in ('S', 'N') else [(s0, e0)]
                for (ss, ee) in segments:
                    col = accent if ss == 0 and side in ('S', 'N') else render
                    zz0 = z0 - (450 if lv == 0 else 0)
                    zz1 = z0 + FF
                    sol = m.box_solid(ss, k0, zz0, ee, k1, zz1) if axis == 'x' else m.box_solid(k0, ss, zz0, k1, ee, zz1)
                    skin = m.add('IfcWall', 'External Finish - Cement Board 12 + Terraco Render', st, [sol],
                                 'Terraco Render' if col == render else 'Terraco Render UniQube Orange', col,
                                 object_type='External Finish - Cement Board 12 + Render', predefined='STANDARD', family='UQ_Facade')
                    for (os_, oe, oz0, oz1, _k) in ops:
                        if os_ >= ss and oe <= ee:
                            m.void(skin, *((os_, k0 - 5, z0 + oz0, oe, k1 + 5, z0 + oz1) if axis == 'x' else (k0 - 5, os_, z0 + oz0, k1 + 5, oe, z0 + oz1)))
                    if lv > 0:
                        bk0, bk1 = sorted((face + out * SKIN, face + out * (SKIN + 20)))
                        bsol = m.box_solid(ss, bk0, z0 - 120, ee, bk1, z0 + 120) if axis == 'x' else m.box_solid(bk0, ss, z0 - 120, bk1, ee, z0 + 120)
                        m.add('IfcCovering', 'Floor Band - Aluminium Composite 240', st, [bsol], 'Aluminium Composite Panel', dark,
                              object_type='Floor Band ACP 240', predefined='CLADDING', family='UQ_Facade')
                    if lv == 0:
                        pk0, pk1 = sorted((face + out * SKIN, face + out * (SKIN + 15)))
                        psol = m.box_solid(ss, pk0, -450, ee, pk1, 450) if axis == 'x' else m.box_solid(pk0, ss, -450, pk1, ee, 450)
                        m.add('IfcCovering', 'Plinth Cladding - Porcelain 600', st, [psol], 'Porcelain Tile', dark,
                              object_type='Plinth 900', predefined='CLADDING', family='UQ_Facade')
            for (os_, oe, oz0, oz1, okind) in ops:
                if okind == 'window':
                    window(st, axis, c, os_, oe, z0)
                elif okind == 'door':
                    door(st, axis, c, os_, oe, z0, DOOR_H, 'Room Entrance Door 900', 'D-01 Room Door 900x2100 FR30', wood, fire='30 min')
                elif okind == 'bathdoor':
                    door(st, axis, c, os_, oe, z0, DOOR_H, 'Bathroom Door 800', 'D-02 Bathroom Door 800x2100 Aluminium', (0.86, 0.87, 0.89))
                elif okind == 'entrance':
                    door(st, axis, c, os_, oe, z0, 2400, 'Main Entrance Door 1200', 'D-00 Glazed Entrance 1200x2400', glass, thick=102)

        zt = z0 + WALL_H + TRUSS_D
        m.add('IfcCovering', 'Ceiling - GB 12.5 MR on furring', st, [m.box_solid(0, 0, z0 + WALL_H - 13, L, D, z0 + WALL_H)],
              'Gypsum Board 12.5 MR', (0.97, 0.97, 0.96), object_type='Ceiling GB 12.5', predefined='CEILING', family='UQ_Ceiling')
        if lv < len(LEVELS) - 1:
            sl = m.add('IfcSlab', 'Floor Deck - Cement Board 18 + Screed 22', m.storeys[lv + 1],
                       [m.box_solid(0, 0, zt, L, D, zt + 40)], 'Cement Board Floor Deck', (0.80, 0.78, 0.73),
                       object_type='Floor Deck 40', predefined='FLOOR', family='UQ_Floor')
            m.void(sl, 0, 0, zt - 5, BAY, DS, zt + 50)
        else:
            rf = m.storeys[3]
            m.add('IfcSlab', 'Roof - Aluminium Sandwich Panel 100', rf, [m.box_solid(-60, -60, zt, L + 60, D + 60, zt + 100)],
                  'Aluminium Sandwich Panel', (0.78, 0.80, 0.83), object_type='Roof Sandwich Panel 100', predefined='ROOF', family='UQ_Roof')
            top = zt + 100
            for (x0, y0, x1, y1) in ((-90, -90, L + 90, -60), (-90, D + 60, L + 90, D + 90), (-90, -60, -60, D + 60), (L + 60, -60, L + 90, D + 60)):
                m.add('IfcWall', 'Parapet 900 - LGS + Cement Board', rf, [m.box_solid(x0, y0, zt - 300, x1, y1, top + 800)],
                      'Terraco Render', render, object_type='Parapet 900', predefined='PARAPET', family='UQ_Facade')
            m.add('IfcRailing', 'Parapet Coping - Aluminium', rf,
                  [m.box_solid(-110, -110, top + 800, L + 110, -40, top + 840), m.box_solid(-110, D + 40, top + 800, L + 110, D + 110, top + 840),
                   m.box_solid(-110, -40, top + 800, -40, D + 40, top + 840), m.box_solid(L + 40, -40, top + 800, L + 110, D + 40, top + 840)],
                  'Aluminium Coping', dark, object_type='Coping 200', family='UQ_Facade')

        if lv < len(LEVELS) - 1:
            rise = FF / 20
            sols = [m.box_solid(600 + i * 270, 300, z0 + i * rise, 870 + i * 270, 1500, z0 + (i + 1) * rise) for i in range(10)]
            sols.append(m.box_solid(3300, 300, z0 + 10 * rise - 150, BAY - 150, 3000, z0 + 10 * rise))
            sols += [m.box_solid(3030 - i * 270, 1800, z0 + (10 + i) * rise, 3300 - i * 270, 3000, z0 + (11 + i) * rise) for i in range(10)]
            m.add('IfcStair', 'Stair ST-01 Steel Stringer + Precast Treads', st, sols, 'Precast Concrete Tread', (0.72, 0.72, 0.70),
                  object_type='ST-01 Dog-leg 1200', predefined='HALF_TURN_STAIR', family='UQ_Stair')
            for (a, b) in (((600, 1500, z0 + 900), (3300, 1500, z0 + 10 * rise + 900)), ((3300, 1800, z0 + 10 * rise + 900), (600, 1800, z0 + FF + 900))):
                m.add('IfcRailing', 'Stair Handrail SS 50', st, [m.solid_between(a, b, 50, 50, up_hint=(0, 1, 0))],
                      'Stainless Steel', (0.80, 0.80, 0.82), object_type='Handrail SS 50', predefined='HANDRAIL', family='UQ_Railing')

        for bay in room_bays():
            b = bay * BAY
            for north in (False, True):
                def Y(a, bb):
                    return (a, bb) if not north else (D - bb, D - a)
                for bx in (b + 300, b + 2350):
                    ya, yb = Y(300, 2300)
                    m.add('IfcFurniture', 'Single Bed 900x2000', st,
                          [m.box_solid(bx, ya, z0, bx + 950, yb, z0 + 300), (m.box_solid(bx + 25, ya + 25, z0 + 300, bx + 925, yb - 25, z0 + 480), (0.90, 0.91, 0.95))],
                          'Timber Veneer', (0.62, 0.46, 0.30), object_type='Bed 900x2000', family='UQ_Furniture', no_color_map=True)
                ya, yb = Y(2400, 2950)
                m.add('IfcFurniture', 'Wardrobe 1200', st, [m.box_solid(b + 1300, ya, z0, b + 2300, yb, z0 + 2100)],
                      'Laminated Board', (0.80, 0.74, 0.64), object_type='Wardrobe 1000x550', family='UQ_Furniture')
    gf = m.storeys[0]
    m.add('IfcSlab', 'External Paving Apron 1500', gf,
          [m.box_solid(-1600, -1600, -150, L + 1600, -150, -70), m.box_solid(-1600, D + 150, -150, L + 1600, D + 1600, -70),
           m.box_solid(-1600, -150, -150, -150, D + 150, -70), m.box_solid(L + 150, -150, -150, L + 1600, D + 150, -70)],
          'Interlock Paving', (0.68, 0.64, 0.58), object_type='Paving 80', predefined='LANDING', family='UQ_Site')
    m.add('IfcSlab', 'Entrance Canopy - ACP', gf, [m.box_solid(-1800, 4800, 2750, -120, 7800, 2900)], 'Aluminium Composite Panel', accent,
          object_type='Canopy ACP', predefined='ROOF', family='UQ_Facade')
    m.write('BlockA_Architecture')


# ================================================================ MEP
def build_mep(panels):
    m = Model('mep', 1_500_000)
    CWc, HWc, DRc, FPc = (0.13, 0.42, 0.95), (0.92, 0.25, 0.15), (0.55, 0.36, 0.20), (0.86, 0.06, 0.06)
    DUCT, TRAY, LIGHT, EQUIP, SAN, COND = (0.80, 0.84, 0.88), (0.96, 0.76, 0.10), (0.98, 0.98, 0.92), (0.55, 0.58, 0.62), (0.97, 0.97, 0.97), (0.20, 0.55, 0.25)

    def panel_at(lv, axis, c, s):
        for (plv, pax, pc, ps, pe, mark) in panels:
            if plv == lv and pax == axis and abs(pc - c) < 1 and ps <= s <= pe:
                return mark
        return None

    def pipe(st, a, b, dia, system, rgb, cls='IfcPipeSegment', mark=None, otype=None):
        mat = 'PPR PN20' if 'Water' in system else ('uPVC' if ('Drain' in system or 'Soil' in system) else ('PVC' if 'Conduit' in system else 'Steel Sch40'))
        return m.add(cls, f'{system} DN{int(dia)}', st, [m.solid_between(a, b, dia, dia, circle=True)], mat, rgb,
                     object_type=otype or f'{system} DN{int(dia)}', mark=mark,
                     props={'System Name': system, 'System Classification': system}, family='UQ_Pipe' if cls == 'IfcPipeSegment' else 'UQ_Conduit')

    def el(cls, name, st, sol, mat, rgb, otype=None, mark=None, props=None, predefined=None, no_color_map=False):
        return m.add(cls, name, st, sol if isinstance(sol, list) else [sol], mat, rgb, object_type=otype or name, mark=mark,
                     props=props, predefined=predefined, family='UQ_MEP', no_color_map=no_color_map)

    for lv, z0 in enumerate(LEVELS):
        st = m.storeys[lv]
        zc = z0 + WALL_H - 40
        yc = DS + CW / 2
        el('IfcDuctSegment', 'Supply Air Duct 500x250', st, m.box_solid(BAY - 300, yc - 250, zc - 250, L - 300, yc + 250, zc),
           'Galvanised Steel', DUCT, props={'System Name': 'Supply Air', 'Insulation': 'Nitrile 25'})
        el('IfcCableCarrierSegment', 'Cable Tray 300x75', st, m.box_solid(300, DS + 150, zc - 420, L - 300, DS + 450, zc - 345),
           'HDG Steel', TRAY, props={'System Name': 'LV Power'}, predefined='CABLETRAYSEGMENT')
        pipe(st, (300, DS + 600, zc - 100), (L - 300, DS + 600, zc - 100), 50, 'Domestic Cold Water', CWc)
        pipe(st, (300, DS + 720, zc - 100), (L - 300, DS + 720, zc - 100), 40, 'Domestic Hot Water', HWc)
        pipe(st, (300, D - DS - 250, zc - 60), (L - 300, D - DS - 250, zc - 60), 65, 'Fire Protection Wet', FPc)
        el('IfcElectricDistributionBoard', f'DB-{lv + 1} Floor Distribution Board', st, m.box_solid(300, D - 250, z0 + 500, 1100, D - 50, z0 + 1700),
           'Steel Enclosure', EQUIP, otype='DB 12-way 63A TPN', props={'System Name': 'LV Power'}, predefined='DISTRIBUTIONBOARD')
        for k in range(NB):
            x = k * BAY + 1800
            el('IfcLightFixture', 'Corridor Downlight LED 18W', st, m.box_solid(x - 110, yc - 110, z0 + WALL_H - 60, x + 110, yc + 110, z0 + WALL_H - 13),
               'Polycarbonate', LIGHT, props={'System Name': 'Lighting'}, predefined='POINTSOURCE')
        for bay in room_bays():
            b = bay * BAY
            for north in (False, True):
                def Y(a):
                    return D - a if north else a
                ywall = DS + CW if north else DS
                ystart = yc + 250 if north else yc - 250
                el('IfcDuctSegment', 'Supply Air Branch 250x200', st, m.box_solid(b + 2600, ystart, zc - 200, b + 2850, Y(3600), zc),
                   'Galvanised Steel', DUCT, props={'System Name': 'Supply Air'})
                el('IfcAirTerminal', 'Square Ceiling Diffuser 600', st,
                   m.box_solid(b + 2425, Y(3600) - 300, z0 + WALL_H - 60, b + 3025, Y(3600) + 300, z0 + WALL_H - 13),
                   'Aluminium', (0.92, 0.93, 0.94), props={'System Name': 'Supply Air'}, predefined='DIFFUSER')
                el('IfcLightFixture', 'Room LED Panel 600x600 36W', st,
                   m.box_solid(b + 1500, Y(1500) - 300, z0 + WALL_H - 50, b + 2100, Y(1500) + 300, z0 + WALL_H - 13),
                   'Aluminium', LIGHT, props={'System Name': 'Lighting'}, predefined='POINTSOURCE')
                yfp = D - DS - 250
                pipe(st, (b + 2700, yfp, zc - 60), (b + 2700, Y(2700), zc - 60), 25, 'Fire Protection Wet', FPc)
                el('IfcFireSuppressionTerminal', 'Pendent Sprinkler K5.6', st,
                   m.solid_between((b + 2700, Y(2700), zc - 60), (b + 2700, Y(2700), z0 + WALL_H - 60), 30, 30, circle=True),
                   'Brass', FPc, props={'System Name': 'Fire Protection Wet'}, predefined='SPRINKLER')
                # first fix in the corridor wall panel next to the door
                xs = b + 3250
                wmark = panel_at(lv, 'x', ywall, xs)
                pipe(st, (xs, ywall, z0 + 1250), (xs, ywall, z0 + WALL_H - 50), 25, 'LV Power Conduit', COND,
                     cls='IfcCableCarrierSegment', mark=wmark, otype='PVC Conduit 25')
                el('IfcSwitchingDevice', 'Light Switch 2-gang + Key Card', st,
                   m.box_solid(xs - 45, ywall - 50, z0 + 1150, xs + 45, ywall + 50, z0 + 1250), 'PC Plate', (0.96, 0.96, 0.96),
                   mark=wmark, props={'System Name': 'Lighting'}, predefined='TOGGLESWITCH')
                # sockets in the party wall panel
                pm = panel_at(lv, 'y', b + BAY, Y(1500))
                el('IfcOutlet', 'Double Socket 13A', st, m.box_solid(b + BAY - 50, Y(1500) - 45, z0 + 300, b + BAY + 50, Y(1500) + 45, z0 + 390),
                   'PC Plate', (0.96, 0.96, 0.96), mark=pm, props={'System Name': 'LV Power'}, predefined='POWEROUTLET')
                pipe(st, (b + BAY, Y(1500), z0 + 390), (b + BAY, Y(1500), z0 + WALL_H - 50), 25, 'LV Power Conduit', COND,
                     cls='IfcCableCarrierSegment', mark=pm, otype='PVC Conduit 25')
                # water into the bathroom wall (NLB panel)
                xb = b + 1800
                nlb = panel_at(lv, 'y', xb, Y(4200))
                for (ymain, dia, sysn, col, xo) in ((DS + 600, 25, 'Domestic Cold Water', CWc, -25), (DS + 720, 20, 'Domestic Hot Water', HWc, 25)):
                    pipe(st, (xb + xo, ymain, zc - 100), (xb + xo, Y(4200), zc - 100), dia, sysn, col)
                    pipe(st, (xb + xo, Y(4200), zc - 100), (xb + xo, Y(4200), z0 + 700), dia, sysn, col, mark=nlb)
                el('IfcSanitaryTerminal', 'WC Wall-hung + Concealed Cistern', st, m.box_solid(b + 350, Y(3050), z0, b + 750, Y(3700), z0 + 420),
                   'Vitreous China', SAN, props={'System Name': 'Sanitary'}, predefined='TOILETPAN')
                el('IfcSanitaryTerminal', 'Wash Basin 500', st, m.box_solid(b + 1250, Y(3050), z0 + 650, b + 1750, Y(3500), z0 + 850),
                   'Vitreous China', SAN, props={'System Name': 'Sanitary'}, predefined='WASHHANDBASIN')
                el('IfcSanitaryTerminal', 'Shower Tray 900x900', st, m.box_solid(b + 60, Y(4440), z0, b + 960, Y(5340), z0 + 60),
                   'Acrylic', SAN, props={'System Name': 'Sanitary'}, predefined='SHOWER')
                if lv == 0:
                    pipe(st, (b + 150, Y(3150), -600), (b + 150, Y(3150), ROOF_TOP + 900), 110, 'Soil and Vent', DRc)
    gf, rf = m.storeys[0], m.storeys[3]
    for y in (3150, D - 3150):
        pipe(gf, (BAY + 150, y, -650), (L + 2500, y, -650), 150, 'Foul Drainage', DRc)
        el('IfcDistributionChamberElement', 'Manhole MH 1200x1200', gf, m.box_solid(L + 1900, y - 600, -1200, L + 3100, y + 600, -70),
           'Precast Concrete', (0.55, 0.55, 0.53), props={'System Name': 'Foul Drainage'}, predefined='MANHOLE')
    pipe(gf, (BAY - 300, DS + 600, -200), (BAY - 300, DS + 600, ROOF_TOP + 1200), 65, 'Domestic Cold Water', CWc, otype='CW Riser DN65')
    pipe(gf, (BAY - 300, DS + 720, 0), (BAY - 300, DS + 720, ROOF_TOP + 300), 50, 'Domestic Hot Water', HWc, otype='HW Riser DN50')
    pipe(gf, (BAY - 300, D - DS - 250, -200), (BAY - 300, D - DS - 250, LEVELS[-1] + WALL_H), 80, 'Fire Protection Wet', FPc, otype='FP Riser DN80')
    zr = ROOF_TOP + 100
    el('IfcTank', 'GRP Sectional Water Tank 20 m3', rf, m.box_solid(500, 7600, zr, 3500, 10600, zr + 2000), 'GRP', (0.30, 0.55, 0.75),
       props={'System Name': 'Domestic Cold Water', 'Capacity': '20 m3'}, predefined='STORAGE')
    el('IfcPump', 'Booster Pump Set', rf, m.box_solid(600, 11000, zr, 2200, 12000, zr + 900), 'Steel', (0.20, 0.35, 0.65),
       props={'System Name': 'Domestic Cold Water'}, predefined='ENDSUCTION')
    el('IfcBuildingElementProxy', 'Solar Water Heater 300 L', rf, m.box_solid(600, 600, zr, 3200, 2600, zr + 1400), 'Aluminium', (0.25, 0.30, 0.40),
       props={'System Name': 'Domestic Hot Water'})
    n = 0
    for bay in room_bays():
        for y in (900, 2300, D - 2300, D - 900):
            for xo in (300, 1900):
                n += 1
                if n > 42:
                    break
                x = bay * BAY + xo
                el('IfcUnitaryEquipment', f'Split AC Outdoor Unit 2.0 TR ODU-{n:02d}', rf,
                   [(m.box_solid(x - 50, y - 380, zr, x + 1050, y + 380, zr + 150), (0.60, 0.60, 0.58)), m.box_solid(x, y - 330, zr + 150, x + 1000, y + 330, zr + 850)],
                   'Steel Powder Coated', (0.90, 0.91, 0.92), otype='ODU 2.0 TR R32', no_color_map=True, props={'System Name': 'Air Conditioning'}, predefined='SPLITSYSTEM')
    m.write('BlockA_MEP')


if __name__ == '__main__':
    reg = build_structure()
    build_architecture()
    build_mep(reg)
