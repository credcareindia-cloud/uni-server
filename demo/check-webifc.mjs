// Load an IFC with web-ifc (same engine as the server import) and report mesh bounds per class.
import fs from 'node:fs'
import * as WebIFC from 'web-ifc'

const file = process.argv[2]
const api = new WebIFC.IfcAPI()
await api.Init()
const id = api.OpenModel(new Uint8Array(fs.readFileSync(file)))
const want = { IFCMEMBER: WebIFC.IFCMEMBER, IFCFOOTING: WebIFC.IFCFOOTING, IFCPIPESEGMENT: WebIFC.IFCPIPESEGMENT, IFCWALL: WebIFC.IFCWALL }
for (const [name, type] of Object.entries(want)) {
  let n = 0
  const samples = []
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  api.StreamAllMeshesWithTypes(id, [type], (mesh) => {
    n++
    const g = mesh.geometries
    for (let i = 0; i < g.size(); i++) {
      const pg = g.get(i)
      const geom = api.GetGeometry(id, pg.geometryExpressID)
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize())
      const m = pg.flatTransformation
      for (let k = 0; k < verts.length; k += 6) {
        const x = verts[k], y = verts[k + 1], z = verts[k + 2]
        const p = [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]) }
        if (samples.length < 3 && k === 0) samples.push(p.map((v) => v.toFixed(3)))
      }
    }
  })
  console.log(name, 'meshes', n, 'min', min.map((v) => v.toFixed(2)), 'max', max.map((v) => v.toFixed(2)), 'first verts', JSON.stringify(samples))
}
