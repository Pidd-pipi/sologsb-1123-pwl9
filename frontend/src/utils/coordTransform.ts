import type { LngLat } from '../types/mission';
import { lngLatToMeters } from './geoCalc';

/**
 * 坐标基准处理：库内统一存 WGS-84，高德 / 腾讯底图采集的点位按 GCJ-02（火星坐标）导入后转换。
 * GCJ-02 转换参数为国家测绘局公开的加偏公式；中国境外不加偏。
 */
export type CoordSystem = 'GCJ-02' | 'WGS-84';

export const COORD_SYSTEMS: { value: CoordSystem; label: string; hint: string }[] = [
  { value: 'GCJ-02', label: '高德 / 腾讯（GCJ-02）', hint: '从高德地图拾取、复制的点位，导入时自动转换为 WGS-84' },
  { value: 'WGS-84', label: '无人机导出（WGS-84）', hint: '无人机 / RTK 导出的 KML、KMZ、航点文件，无需转换' },
];

const PI = Math.PI;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;
/** 测区边界判定容差 m（转换后落在边界 0.5 m 内视为区内） */
const BOUNDARY_TOL_M = 0.5;

export function isValidLngLat(lng: unknown, lat: unknown): boolean {
  return (
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/** 中国境外不做 GCJ-02 加偏 */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * (2.0 / 3.0);
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * (2.0 / 3.0);
  ret += (160.0 * Math.sin((y / 12.0) * PI) - 320.0 * Math.sin((y * PI) / 30.0)) * (2.0 / 3.0);
  return ret;
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * (2.0 / 3.0);
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * (2.0 / 3.0);
  ret += (150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * (2.0 / 3.0);
  return ret;
}

/** WGS-84 → GCJ-02（高德坐标） */
export function wgs84ToGcj02(lng: number, lat: number): LngLat {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ-02（高德坐标）→ WGS-84，定点迭代反解，三次迭代误差小于 1 mm */
export function gcj02ToWgs84(lng: number, lat: number): LngLat {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wgsLng = lng;
  let wgsLat = lat;
  for (let i = 0; i < 3; i += 1) {
    const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
    wgsLng += lng - gcjLng;
    wgsLat += lat - gcjLat;
  }
  return [wgsLng, wgsLat];
}

/** 按来源坐标系统一转 WGS-84 入库 */
export function toWgs84(lng: number, lat: number, source: CoordSystem): LngLat {
  return source === 'GCJ-02' ? gcj02ToWgs84(lng, lat) : [lng, lat];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 点是否落在测区多边形内（射线法 + 边界容差）；多边形不足 3 个顶点时不做区内限制 */
export function pointInPolygon(point: LngLat, polygon: LngLat[]): boolean {
  if (!polygon || polygon.length < 3) return true;
  const [x, y] = point;

  // 边界容差：点到任一边距离不超过 0.5 m 即视为区内
  const tol2 = BOUNDARY_TOL_M * BOUNDARY_TOL_M;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const pa = lngLatToMeters(point, a);
    const ba = lngLatToMeters(b, a);
    const denom = ba.x * ba.x + ba.y * ba.y;
    const t = denom > 0 ? clamp((pa.x * ba.x + pa.y * ba.y) / denom, 0, 1) : 0;
    const dx = pa.x - ba.x * t;
    const dy = pa.y - ba.y * t;
    if (dx * dx + dy * dy <= tol2) return true;
  }

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
