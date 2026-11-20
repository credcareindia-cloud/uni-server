import sys
import ifcopenshell
import ifcopenshell.geom
import numpy as np

f = ifcopenshell.open(sys.argv[1])
s = ifcopenshell.geom.settings()
s.set('use-world-coords', True)
for cls in sys.argv[2:]:
    els = f.by_type(cls)[:3]
    for e in els:
        try:
            sh = ifcopenshell.geom.create_shape(s, e)
            v = np.array(sh.geometry.verts).reshape(-1, 3)
            print(cls, e.Name, 'verts', len(v), 'min', v.min(0).round(3), 'max', v.max(0).round(3))
        except Exception as ex:
            print(cls, e.Name, 'ERROR', ex)
