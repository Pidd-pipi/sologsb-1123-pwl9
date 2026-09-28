/** 航点动作 */
export type WaypointAction = '拍照' | '悬停' | '转弯';

export const WAYPOINT_ACTIONS: WaypointAction[] = ['拍照', '悬停', '转弯'];

/**
 * 来源坐标系：
 * - WGS84：GPS / 无人机导出（DJI Pilot 等），也是入库统一坐标系
 * - GCJ02：高德 / 腾讯地图拾取坐标
 */
export type CoordSystem = 'WGS84' | 'GCJ02';

export const COORD_SYSTEMS: { value: CoordSystem; label: string; hint: string }[] = [
  { value: 'WGS84', label: 'WGS-84（无人机 / GPS）', hint: '无人机遥控器与航线文件导出的坐标' },
  { value: 'GCJ02', label: 'GCJ-02（高德 / 腾讯）', hint: '高德地图拾取的坐标，导入时自动转换为 WGS-84' },
];

/** 航点 */
export interface Waypoint {
  id: string;
  missionId: string;
  seq: number;
  /** 统一存储的 WGS-84 经度（航线折线、视场、航程全部使用它） */
  lng: number;
  /** 统一存储的 WGS-84 纬度 */
  lat: number;
  /** 原始来源坐标系；老数据可能缺省，打开时按 WGS-84 处理，重新保存后补齐 */
  coordSystem?: CoordSystem;
  /** 粘贴导入时的原始经度（不做转换），WGS-84 来源时与 lng 相同 */
  sourceLng?: number;
  /** 粘贴导入时的原始纬度 */
  sourceLat?: number;
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

export interface ParsedWaypointRow {
  /** 文本中的行号（从 1 起，仅计非空行的连续行号 → 实际文件行号） */
  lineNo: number;
  lng: number;
  lat: number;
  altitude?: number;
}

export interface ParseWaypointResult {
  rows: ParsedWaypointRow[];
  /** 无法解析或经纬度越界的行号 */
  invalidLines: number[];
}

/**
 * 解析粘贴导入文本：每行 "经度,纬度[,航高]" 或 "纬度 经度" 自动判别。
 * 返回有效行（带文本行号）与无效行号，便于整批失败时指出具体行。
 */
export function parseWaypointText(text: string): ParseWaypointResult {
  const rows: ParsedWaypointRow[] = [];
  const invalidLines: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line) return;
    const nums = line.split(/[,\s\t;]+/).map((p) => Number(p));
    const parts = nums.filter((n) => Number.isFinite(n));
    if (parts.length < 2) {
      invalidLines.push(lineNo);
      return;
    }
    const [a, b, c] = parts;
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
      invalidLines.push(lineNo);
      return;
    }
    rows.push(c !== undefined ? { lineNo, lng, lat, altitude: c } : { lineNo, lng, lat });
  });
  return { rows, invalidLines };
}
