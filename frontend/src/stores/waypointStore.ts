import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { CoordSystem, Waypoint, WaypointDraft } from '../types/waypoint';

/** 入库归一：未标来源的航点按 WGS-84 处理，并保证原始坐标字段有值 */
function normalizeDraft(draft: WaypointDraft): WaypointDraft {
  const coordSystem: CoordSystem = draft.coordSystem ?? 'WGS84';
  return {
    ...draft,
    coordSystem,
    sourceLng: draft.sourceLng ?? draft.lng,
    sourceLat: draft.sourceLat ?? draft.lat,
  };
}

interface WaypointState {
  items: Waypoint[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: WaypointDraft) => Promise<Waypoint>;
  addMany: (drafts: WaypointDraft[]) => Promise<Waypoint[]>;
  update: (id: string, patch: Partial<Waypoint>) => Promise<void>;
  /** 把任务内没标来源的老航点统一补成 WGS-84（重新保存补来源） */
  backfillCoordSystem: (missionId: string, coordSystem?: CoordSystem) => Promise<number>;
  move: (id: string, direction: 'up' | 'down') => Promise<void>;
  reorder: (fromId: string, toId: string) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byMission: (missionId: string) => Waypoint[];
}

export const useWaypointStore = create<WaypointState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.waypoints.toArray();
    rows.sort((a, b) => a.seq - b.seq);
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const record: Waypoint = { ...normalizeDraft(draft), id: newId('wp') };
    await db.waypoints.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async addMany(drafts) {
    const records: Waypoint[] = drafts.map((d) => ({ ...normalizeDraft(d), id: newId('wp') }));
    await db.waypoints.bulkPut(records);
    set({ items: [...get().items, ...records] });
    return records;
  },
  async update(id, patch) {
    const current = get().items.find((it) => it.id === id);
    // 老数据在页面上重新编辑保存时，顺手补上来源（默认 WGS-84）
    const nextPatch = current && !current.coordSystem ? { coordSystem: 'WGS84' as const, ...patch } : patch;
    await db.waypoints.update(id, nextPatch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...nextPatch } : it)) });
  },
  async backfillCoordSystem(missionId, coordSystem = 'WGS84') {
    const targets = get().items.filter((it) => it.missionId === missionId && !it.coordSystem);
    if (targets.length === 0) return 0;
    const ids = new Set(targets.map((t) => t.id));
    await db.waypoints.where('id').anyOf([...ids]).modify((w: Waypoint) => {
      w.coordSystem = coordSystem;
      if (w.sourceLng === undefined) w.sourceLng = w.lng;
      if (w.sourceLat === undefined) w.sourceLat = w.lat;
    });
    set({
      items: get().items.map((it) =>
        ids.has(it.id)
          ? { ...it, coordSystem, sourceLng: it.sourceLng ?? it.lng, sourceLat: it.sourceLat ?? it.lat }
          : it,
      ),
    });
    return targets.length;
  },
  /** 与相邻航点交换序号 */
  async move(id, direction) {
    const list = get().byMission(get().items.find((it) => it.id === id)?.missionId ?? '');
    const index = list.findIndex((it) => it.id === id);
    const target = direction === 'up' ? list[index - 1] : list[index + 1];
    if (!target) return;
    await get().reorder(id, target.id);
  },
  async reorder(fromId, toId) {
    const from = get().items.find((it) => it.id === fromId);
    const to = get().items.find((it) => it.id === toId);
    if (!from || !to) return;
    const fromSeq = from.seq;
    await db.waypoints.update(from.id, { seq: to.seq });
    await db.waypoints.update(to.id, { seq: fromSeq });
    set({
      items: get().items.map((it) => {
        if (it.id === from.id) return { ...it, seq: to.seq };
        if (it.id === to.id) return { ...it, seq: fromSeq };
        return it;
      }),
    });
  },
  async removeByMission(missionId) {
    const ids = get().items.filter((it) => it.missionId === missionId).map((it) => it.id);
    await db.waypoints.bulkDelete(ids);
    set({ items: get().items.filter((it) => it.missionId !== missionId) });
  },
  async remove(id) {
    await db.waypoints.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byMission(missionId) {
    return get()
      .items.filter((it) => it.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
