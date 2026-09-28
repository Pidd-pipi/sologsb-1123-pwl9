import type { CoordSystem } from '../utils/coordTransform';

/** 航点动作 */
export type WaypointAction = '拍照' | '悬停' | '转弯';

export const WAYPOINT_ACTIONS: WaypointAction[] = ['拍照', '悬停', '转弯'];

/**
 * 航点。
 * 库内坐标（lng/lat）统一为 WGS-84，是航线折线、视场、距离计算的唯一位置来源；
 * origLng/origLat 保留导入时的原始坐标，source 标明来源坐标基准。
 * source 缺省只可能出现在旧版本数据上：打开时按 WGS-84 处理，重新保存后补上。
 */
export interface Waypoint {
  id: string;
  missionId: string;
  seq: number;
  /** 入库 WGS-84 经度（航线 / 视场 / 距离统一使用） */
  lng: number;
  /** 入库 WGS-84 纬度 */
  lat: number;
  /** 导入时的原始经度（GCJ-02 导入时与 lng 不同） */
  origLng: number;
  /** 导入时的原始纬度 */
  origLat: number;
  /** 原始坐标来源坐标系；旧数据缺省，按 WGS-84 打开，重新保存后补标 */
  source?: CoordSystem;
  /** 相对航高 m */
  altitude: number;
  /** 航速 m/s */
  speed: number;
  /** 航向 ° */
  heading: number;
  /** 云台俯仰 ° */
  gimbalPitch: number;
  action: WaypointAction;
  /** 悬停秒数 */
  hoverSec: number;
}

export type WaypointDraft = Omit<Waypoint, 'id'>;

/** 解析出的原始坐标点（未做基准转换） */
export interface ParsedWaypointPoint {
  /** 对应粘贴文本中的行号（从 1 开始） */
  line: number;
  lng: number;
  lat: number;
  altitude?: number;
}

export interface WaypointLineError {
  /** 对应粘贴文本中的行号（从 1 开始） */
  line: number;
  reason: string;
}

/**
 * 解析粘贴导入文本：每行 "经度,纬度[,航高]" 或 "纬度 经度" 自动判别。
 * 不再静默丢弃坏行——非法行连同行号一起返回，由调用方整批拒收。
 */
export function parseWaypointText(text: string): { points: ParsedWaypointPoint[]; errors: WaypointLineError[] } {
  const points: ParsedWaypointPoint[] = [];
  const errors: WaypointLineError[] = [];
  text
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = index + 1;
      const trimmed = raw.trim();
      if (!trimmed) return;
      const tokens = trimmed.split(/[,\s\t;]+/).map((p) => p.trim());
      if (tokens.length < 2) {
        errors.push({ line, reason: '至少需要「经度,纬度」两列' });
        return;
      }
      if (tokens.length > 3) {
        errors.push({ line, reason: `列数过多（${tokens.length} 列），每行应为「经度,纬度[,航高]」` });
        return;
      }
      if (tokens.some((t) => t === '' || Number.isNaN(Number(t)))) {
        errors.push({ line, reason: '存在无法识别为数字的字段' });
        return;
      }
      const parts = tokens.map(Number);
      if (!parts.every((n) => Number.isFinite(n))) {
        errors.push({ line, reason: '存在非有限数值（Infinity / NaN）' });
        return;
      }
      let [a, b, c] = parts;
      // 中国境内经度 73~136、纬度 3~54；若首个数落在纬度范围而第二个落在经度范围，则交换
      const aIsLng = a >= 73 && a <= 136;
      const bIsLng = b >= 73 && b <= 136;
      let lng = a;
      let lat = b;
      if (!aIsLng && bIsLng) {
        lng = b;
        lat = a;
      }
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        errors.push({ line, reason: `坐标越界（经度 ${lng}，纬度 ${lat}）` });
        return;
      }
      if (c !== undefined && c <= 0) {
        errors.push({ line, reason: `航高必须为正数（收到 ${c} m）` });
        return;
      }
      points.push(c !== undefined ? { line, lng, lat, altitude: c } : { line, lng, lat });
    });
  return { points, errors };
}
