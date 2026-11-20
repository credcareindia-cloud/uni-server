/**
 * Demo tracking data for the Block A showcase project: statuses, status history, shipment groups,
 * QR codes and scans, notifications, dashboard logistics and two website quote requests.
 * Every panel that shares a BIMSF mark moves together, the way site teams scan whole panels.
 *
 *   node demo/seed-demo-tracking.mjs <projectId>
 *
 * Safe to re-run: it clears this project's statuses, groups and QR codes first.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const projectId = Number(process.argv[2])
if (!projectId) throw new Error('Usage: node demo/seed-demo-tracking.mjs <projectId>')

const STATUSES = [
  { name: 'Design Approved', color: '#6366F1', icon: 'check-circle', description: 'Shop drawings approved, CNC files released' },
  { name: 'In Production', color: '#F59E0B', icon: 'factory', description: 'Roll-forming and assembly at Hamriyah factory' },
  { name: 'QC Passed', color: '#14B8A6', icon: 'shield-check', description: 'Dimensional and weld/screw QC signed off' },
  { name: 'Dispatched', color: '#3B82F6', icon: 'truck', description: 'Loaded on trailer with delivery note' },
  { name: 'Delivered', color: '#8B5CF6', icon: 'package-check', description: 'Received on site and checked against the delivery note' },
  { name: 'Installed', color: '#22C55E', icon: 'hammer', description: 'Erected, plumbed and fixed on site' },
]
const STAGE = Object.fromEntries(STATUSES.map((s, i) => [s.name, i]))

// deterministic jitter
let seed = 42
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
const day = (iso, plusDays, hour = 9) => {
  const d = new Date(`${iso}T00:00:00+04:00`)
  d.setTime(d.getTime() + plusDays * 86400000 + (hour + rnd() * 7) * 3600000)
  return d
}

function parseMark(mark) {
  if (/foundation/i.test(mark)) return { kind: 'FND', floor: 0, seq: 0 }
  const m = /^(ELB|NLB|LB|FT|RT)-?(\d+)$/i.exec(mark)
  if (!m) return null
  const n = Number(m[2])
  return { kind: m[1].toUpperCase(), floor: Math.floor(n / 1000), seq: n % 1000 }
}

/** Where each panel stands on 20 Nov 2026, and the day production started for it. */
function plan(info) {
  const { kind, floor, seq } = info
  if (kind === 'FND') return { stage: 'Installed', start: '2026-09-20' }
  if (floor === 1 && kind !== 'FT') return { stage: 'Installed', start: '2026-10-05' }
  if (floor === 1 && kind === 'FT') return { stage: 'Installed', start: '2026-10-12' }
  if (floor === 2 && (kind === 'ELB' || kind === 'LB')) return { stage: seq <= (kind === 'ELB' ? 46 : 52) ? 'Installed' : 'Delivered', start: '2026-10-22' }
  if (floor === 2 && kind === 'NLB') return { stage: 'Delivered', start: '2026-10-28' }
  if (floor === 2 && kind === 'FT') return { stage: seq <= 12 ? 'Delivered' : 'Dispatched', start: '2026-11-02' }
  if (floor === 3 && kind === 'ELB') return { stage: 'QC Passed', start: '2026-11-10' }
  if (floor === 3 && kind === 'LB') return { stage: seq <= 30 ? 'QC Passed' : 'In Production', start: '2026-11-13' }
  if (floor === 3 && kind === 'NLB') return { stage: 'In Production', start: '2026-11-16' }
  if (kind === 'RT') return { stage: 'Design Approved', start: '2026-11-18' }
  return { stage: 'Design Approved', start: '2026-11-18' }
}
// days from production start to each milestone
const OFFSETS = { 'Design Approved': -9, 'In Production': 0, 'QC Passed': 2, Dispatched: 4, Delivered: 5, Installed: 8 }
const NOTES = {
  'QC Passed': ['Dimensions within ±1 mm, screw pattern checked', 'Diagonal check OK, labels fixed', 'QC by Arbab K. — all members tagged'],
  Dispatched: ['Loaded on trailer SHJ-48213', 'Loaded on trailer SHJ-51907', 'Loaded on trailer AJM-20416'],
  Delivered: ['Received at gate, delivery note DN-', 'Offloaded by site crane, no damage', 'Checked against DN, stacked in laydown area B'],
  Installed: ['Plumbed and anchored', 'Fixed to track, bracing complete', 'Installed by Gang 2'],
}

async function main() {
  const project = await prisma.project.findUnique({ where: { id: projectId } })
  if (!project) throw new Error(`Project ${projectId} not found`)
  const admin = await prisma.user.findFirst({ where: { email: 'admin@uniqube.com' } })
  const userId = admin?.id ?? null

  // clean slate for this project
  await prisma.qRCode.deleteMany({ where: { projectId } })
  const oldGroups = await prisma.group.findMany({ where: { projectId }, select: { id: true } })
  await prisma.panelGroup.deleteMany({ where: { groupId: { in: oldGroups.map((g) => g.id) } } })
  await prisma.group.deleteMany({ where: { projectId } })
  const panelsAll = await prisma.panel.findMany({ where: { projectId }, select: { id: true, metadata: true, name: true } })
  const panelIds = panelsAll.map((p) => p.id)
  for (let i = 0; i < panelIds.length; i += 5000) {
    const ids = panelIds.slice(i, i + 5000)
    await prisma.statusHistory.deleteMany({ where: { panelId: { in: ids } } })
    await prisma.panelStatus.deleteMany({ where: { panelId: { in: ids } } })
  }
  await prisma.status.deleteMany({ where: { projectId } })

  const statusRows = []
  for (const [order, s] of STATUSES.entries()) {
    statusRows.push(await prisma.status.create({ data: { projectId, order, isDefault: false, ...s } }))
  }
  const statusId = Object.fromEntries(statusRows.map((s) => [s.name, s.id]))

  // panels by BIMSF mark
  const byMark = new Map()
  for (const p of panelsAll) {
    const mark = p.metadata?.BIMSF_Container
    if (!mark) continue
    if (!byMark.has(mark)) byMark.set(mark, [])
    byMark.get(mark).push(p.id)
  }
  const marks = [...byMark.keys()].map((mark) => ({ mark, info: parseMark(mark) })).filter((m) => m.info)
  marks.sort((a, b) => a.info.floor - b.info.floor || a.info.kind.localeCompare(b.info.kind) || a.info.seq - b.info.seq)

  const panelStatus = []
  const history = []
  const markStage = new Map()
  for (const { mark, info } of marks) {
    const p = plan(info)
    markStage.set(mark, { ...p, info })
    const reached = STATUSES.slice(0, STAGE[p.stage] + 1).map((s) => s.name)
    const stagger = Math.floor(info.seq / 12)
    const stamps = Object.fromEntries(reached.map((name) => [name, day(p.start, OFFSETS[name] + stagger)]))
    const notes = Object.fromEntries(reached.map((name) => {
      const list = NOTES[name]
      if (!list) return [name, null]
      const n = list[Math.floor(rnd() * list.length)]
      return [name, n.endsWith('DN-') ? `${n}${2600 + stagger * 3 + Math.floor(rnd() * 3)}` : n]
    }))
    for (const panelId of byMark.get(mark)) {
      for (const name of reached) {
        panelStatus.push({ panelId, statusId: statusId[name], assignedAt: stamps[name], assignedBy: userId })
        history.push({ panelId, statusId: statusId[name], action: 'ASSIGNED', notes: notes[name], changedBy: userId, createdAt: stamps[name] })
      }
    }
  }
  for (let i = 0; i < panelStatus.length; i += 5000) await prisma.panelStatus.createMany({ data: panelStatus.slice(i, i + 5000), skipDuplicates: true })
  for (let i = 0; i < history.length; i += 5000) await prisma.statusHistory.createMany({ data: history.slice(i, i + 5000) })

  // shipment groups: trailer loads in install order
  const loads = []
  const order = marks.filter((m) => m.info.kind !== 'FND')
  const floorName = (f) => ['Foundation', 'Ground Floor', 'First Floor', 'Second Floor'][f] ?? `Level ${f}`
  const kindName = { ELB: 'External Walls', LB: 'Internal Walls', NLB: 'Bathroom Walls', FT: 'Floor Cassettes', RT: 'Roof Trusses' }
  const bucket = new Map()
  for (const m of order) {
    const key = `${m.info.floor}|${m.info.kind}`
    if (!bucket.has(key)) bucket.set(key, [])
    bucket.get(key).push(m)
  }
  let n = 0
  for (const [key, list] of bucket) {
    const size = list[0].info.kind === 'FT' || list[0].info.kind === 'RT' ? 12 : 24
    for (let i = 0; i < list.length; i += size) {
      n += 1
      const chunk = list.slice(i, i + size)
      const [floor, kind] = key.split('|')
      const stages = chunk.map((c) => STAGE[markStage.get(c.mark).stage])
      const min = Math.min(...stages)
      const status = min >= STAGE.Installed ? 'COMPLETED' : min >= STAGE.Dispatched ? 'IN_PROGRESS' : 'PENDING'
      loads.push({
        name: `TRL-${String(n).padStart(2, '0')} · ${floorName(Number(floor))} ${kindName[kind]}`,
        description: `${chunk.length} panels ${chunk[0].mark}–${chunk[chunk.length - 1].mark} · 40 ft flatbed, Hamriyah factory → site`,
        status,
        color: status === 'COMPLETED' ? '#22C55E' : status === 'IN_PROGRESS' ? '#3B82F6' : '#94A3B8',
        marks: chunk.map((c) => c.mark),
      })
    }
  }
  const panelGroups = []
  for (const load of loads) {
    const g = await prisma.group.create({
      data: { projectId, name: load.name, description: load.description, status: load.status, color: load.color, metadata: { type: 'shipment', marks: load.marks } },
    })
    for (const mark of load.marks) for (const panelId of byMark.get(mark)) panelGroups.push({ panelId, groupId: g.id, assignedBy: userId })
  }
  for (let i = 0; i < panelGroups.length; i += 5000) await prisma.panelGroup.createMany({ data: panelGroups.slice(i, i + 5000), skipDuplicates: true })

  // QR codes on every dispatched panel, scans at the gate and at installation
  let qrCount = 0
  let scanCount = 0
  for (const { mark } of marks) {
    const st = markStage.get(mark)
    if (STAGE[st.stage] < STAGE.Dispatched) continue
    const panelId = byMark.get(mark)[0]
    const scans = []
    if (STAGE[st.stage] >= STAGE.Delivered) scans.push(day(st.start, OFFSETS.Delivered + Math.floor(st.info.seq / 12), 8))
    if (STAGE[st.stage] >= STAGE.Installed) scans.push(day(st.start, OFFSETS.Installed + Math.floor(st.info.seq / 12), 10))
    const qr = await prisma.qRCode.create({ data: { panelId, projectId, scanCount: scans.length } })
    qrCount += 1
    if (scans.length) {
      await prisma.qRScan.createMany({
        data: scans.map((scannedAt) => ({ qrCodeId: qr.id, scannedAt, userAgent: 'UniQube Site (Android 14; Samsung Galaxy XCover7)', ipAddress: '10.20.4.17' })),
      })
      scanCount += scans.length
    }
  }

  // dashboard logistics
  const metadata = { ...(project.metadata ?? {}) }
  metadata.dashboard = {
    projectSize: '1,089 m² GFA · 42 rooms · G+2',
    vessel: 'Road freight · 40 ft flatbeds',
    container: `${loads.filter((l) => l.status !== 'PENDING').length} of ${loads.length} loads dispatched`,
    departure: '2026-11-18',
    eta: '2026-11-22',
    port: 'Hamriyah Freezone Phase 2, Sharjah',
    factory: 'UniQube Factory, Hamriyah Freezone, Sharjah',
    dailyRate: '24 panels / day',
    forecast: '2026-12-18',
    sitePhotoUrl: '',
    sitePhotoDocumentId: '',
  }
  metadata.client = metadata.client || 'Hamriyah Freezone Authority'
  await prisma.project.update({ where: { id: projectId }, data: { status: 'ACTIVE', metadata } })

  // notifications for the admin
  if (admin) {
    const base = { userId: admin.id, organizationId: admin.organizationId, status: 'SUCCESS', recipientRole: 'ADMIN' }
    const items = [
      ['GROUP_STATUS_CHANGE', 'First Floor walls 70% installed', 'Gang 2 installed 98 wall panels on the first floor this week.', '2026-11-20T09:40:00+04:00', false],
      ['PROJECT_UPDATE', 'Load dispatched: First Floor Floor Cassettes', 'Trailer SHJ-51907 left the factory with 12 FT cassettes.', '2026-11-19T15:10:00+04:00', false],
      ['PROJECT_UPDATE', 'QC passed: Second Floor external walls', 'All ELB3xxx panels passed dimensional QC.', '2026-11-18T12:25:00+04:00', false],
      ['MODEL_PROCESSED', 'Block A models published', 'Structure, architecture and MEP published from Revit (v1).', '2026-11-17T08:05:00+04:00', true],
      ['SYSTEM', 'Roof trusses released to production', 'RT-3001 to RT-3024 cut lists sent to the CNC line.', '2026-11-18T10:00:00+04:00', true],
    ]
    for (const [type, title, message, at, read] of items) {
      await prisma.notification.create({ data: { ...base, type, title, message, read, createdAt: new Date(at), metadata: { projectId } } })
    }
    // two website requests waiting in Requests
    for (const q of [
      { name: 'Rashid Al Mansoori', email: 'rashid@almansoori-dev.ae', projectName: 'Al Hamra Labour Camp - Phase 2', note: 'G+1, 120 rooms, need budget price and programme. Site in Ras Al Khaimah.' },
      { name: 'Priya Nair', email: 'priya.nair@greenfield-schools.com', projectName: 'Greenfield School Annex', note: '6 classrooms + toilets, single storey, fast-track for September intake.' },
    ]) {
      await prisma.quoteRequest.create({ data: { organizationId: admin.organizationId, source: 'WEB', status: 'NEW', ...q } })
    }
  }

  const counts = Object.fromEntries(STATUSES.map((s) => [s.name, 0]))
  for (const [, st] of markStage) counts[st.stage] += 1
  console.log(JSON.stringify({ projectId, panels: panelsAll.length, bimsfPanels: marks.length, currentStage: counts, panelStatus: panelStatus.length, history: history.length, loads: loads.length, qrCount, scanCount }, null, 2))
}

main().finally(() => prisma.$disconnect())
