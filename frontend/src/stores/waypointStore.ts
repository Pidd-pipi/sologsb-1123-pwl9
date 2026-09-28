import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Waypoint, WaypointDraft } from '../types/waypoint';

/** 库内补齐字段：旧数据没有原始坐标与来源标记，坐标即原始坐标，来源按 WGS-84 处理 */
function normalize(row: Waypoint): Waypoint {
  if (row.source) return row;
  return {
    ...row,
    source: 'WGS-84',
    origLng: row.origLng ?? row.lng,
    origLat: row.origLat ?? row.lat,
  };
}

interface WaypointState {
  items: Waypoint[];
  /** 本次会话里仍未把来源标记写回库的旧数据 id */
  legacyIds: string[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: WaypointDraft) => Promise<Waypoint>;
  addMany: (drafts: WaypointDraft[]) => Promise<Waypoint[]>;
  update: (id: string, patch: Partial<Waypoint>) => Promise<void>;
  move: (id: string, direction: 'up' | 'down') => Promise<void>;
  reorder: (fromId: string, toId: string) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byMission: (missionId: string) => Waypoint[];
}

export const useWaypointStore = create<WaypointState>((set, get) => ({
  items: [],
  legacyIds: [],
  loaded: false,
  async load() {
    const rows = await db.waypoints.toArray();
    rows.sort((a, b) => a.seq - b.seq);
    const legacyIds: string[] = [];
    const items = rows.map((raw) => {
      const record = normalize(raw);
      if (!raw.source) legacyIds.push(record.id);
      return record;
    });
    set({ items, legacyIds, loaded: true });
  },
  async add(draft) {
    const record: Waypoint = { ...draft, id: newId('wp') };
    await db.waypoints.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async addMany(drafts) {
    const records: Waypoint[] = drafts.map((d) => ({ ...d, id: newId('wp') }));
    await db.waypoints.bulkPut(records);
    set({ items: [...get().items, ...records] });
    return records;
  },
  async update(id, patch) {
    const current = get().items.find((it) => it.id === id);
    if (!current) return;
    // 写回整行（含补齐的 source / origLng / origLat），旧数据借此补上来源
    const next: Waypoint = { ...current, ...patch };
    await db.waypoints.put(next);
    set({
      items: get().items.map((it) => (it.id === id ? next : it)),
      legacyIds: get().legacyIds.filter((wid) => wid !== id),
    });
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
    // put 整行，交换序号同时把旧数据的来源标记补写入库
    await db.waypoints.put({ ...from, seq: to.seq });
    await db.waypoints.put({ ...to, seq: fromSeq });
    const stamped = new Set([from.id, to.id]);
    set({
      items: get().items.map((it) => {
        if (it.id === from.id) return { ...it, seq: to.seq };
        if (it.id === to.id) return { ...it, seq: fromSeq };
        return it;
      }),
      legacyIds: get().legacyIds.filter((wid) => !stamped.has(wid)),
    });
  },
  async removeByMission(missionId) {
    const ids = get().items.filter((it) => it.missionId === missionId).map((it) => it.id);
    await db.waypoints.bulkDelete(ids);
    const removed = new Set(ids);
    set({
      items: get().items.filter((it) => it.missionId !== missionId),
      legacyIds: get().legacyIds.filter((id) => !removed.has(id)),
    });
  },
  async remove(id) {
    await db.waypoints.delete(id);
    set({
      items: get().items.filter((it) => it.id !== id),
      legacyIds: get().legacyIds.filter((wid) => wid !== id),
    });
  },
  byMission(missionId) {
    return get()
      .items.filter((it) => it.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
  },
}));
