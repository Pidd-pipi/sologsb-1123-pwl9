import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { ImportOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import {
  COORD_SYSTEMS,
  WAYPOINT_ACTIONS,
  parseWaypointText,
  type CoordSystem,
  type Waypoint,
  type WaypointAction,
} from '../types/waypoint';
import { calcGsd, groundCoverage, pointInPolygon } from '../utils/geoCalc';
import { isValidLngLat, toWgs84 } from '../utils/coordTransform';

type Columns = NonNullable<TableProps<Waypoint>['columns']>;

/** 格式化行号列表：相邻行合并为区间，如 1,2,3,7 → 1-3、7 */
function formatLineNos(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  sorted.slice(1).forEach((n) => {
    if (n === prev + 1) {
      prev = n;
      return;
    }
    ranges.push(start === prev ? `第 ${start} 行` : `第 ${start}-${prev} 行`);
    start = n;
    prev = n;
  });
  ranges.push(start === prev ? `第 ${start} 行` : `第 ${start}-${prev} 行`);
  return ranges.join('、');
}

/** /missions/:id/waypoints 航点明细：经纬度粘贴导入、批量改高度、顺序拖拽、单点视场预览 */
export default function WaypointTable() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addMany = useWaypointStore((s) => s.addMany);
  const update = useWaypointStore((s) => s.update);
  const move = useWaypointStore((s) => s.move);
  const reorder = useWaypointStore((s) => s.reorder);
  const remove = useWaypointStore((s) => s.remove);
  const clearMission = useWaypointStore((s) => s.removeByMission);
  const backfillCoordSystem = useWaypointStore((s) => s.backfillCoordSystem);

  const mission = missions.find((m) => m.id === id);
  const rows = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );
  /** 老数据：未标来源坐标系的航点，打开时按 WGS-84 处理 */
  const unmarkedCount = useMemo(() => rows.filter((w) => !w.coordSystem).length, [rows]);

  const [pasteText, setPasteText] = useState('');
  /** 粘贴数据的来源坐标系：高德点位选 GCJ-02，无人机导出选 WGS-84 */
  const [sourceCrs, setSourceCrs] = useState<CoordSystem>('GCJ02');
  const [batchAltitude, setBatchAltitude] = useState(120);
  const [previewId, setPreviewId] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const preview = rows.find((w) => w.id === previewId) ?? rows[0];
  const metrics = useRouteMetrics(id, { ...DEFAULT_ROUTE_PARAMS, altitude: preview?.altitude ?? 120 });

  const importPaste = async () => {
    // 1) 逐行解析，坐标格式 / 经纬度越界的行直接整批拒绝
    const { rows: parsed, invalidLines } = parseWaypointText(pasteText);
    if (invalidLines.length > 0) {
      setError(`坐标无效，未写入任何航点：${formatLineNos(invalidLines)}无法解析或经纬度越界，请按「经度,纬度[,航高]」修正后重新导入。`);
      return;
    }
    if (parsed.length === 0) {
      setError('未解析到有效经纬度：每行应为「经度,纬度[,航高]」');
      return;
    }

    // 2) 按选定的来源坐标系统一转 WGS-84；转换结果非法同样整批拒绝
    const converted = parsed.map((p) => {
      const [lng, lat] = toWgs84(p.lng, p.lat, sourceCrs);
      return { ...p, wgsLng: lng, wgsLat: lat };
    });
    const badConvert = converted.filter((p) => !isValidLngLat(p.wgsLng, p.wgsLat)).map((p) => p.lineNo);
    if (badConvert.length > 0) {
      setError(`转换后坐标无效，未写入任何航点：${formatLineNos(badConvert)}`);
      return;
    }

    // 3) 转换后超出测区边界的行整批拒绝（无测区多边形时跳过该校验）
    const polygon = mission?.areaPolygon ?? [];
    if (polygon.length >= 3) {
      const outside = converted
        .filter((p) => !pointInPolygon([p.wgsLng, p.wgsLat], polygon))
        .map((p) => p.lineNo);
      if (outside.length > 0) {
        setError(
          `转换后坐标超出测区，未写入任何航点：${formatLineNos(outside)}。请确认来源坐标系选择是否正确（高德点位应为 GCJ-02，无人机导出应为 WGS-84），或先扩大测区边界。`,
        );
        return;
      }
    }

    // 4) 全部通过：原始坐标与转换后坐标都保留，折线 / 视场只用 WGS-84 字段
    const startSeq = rows.length === 0 ? 1 : Math.max(...rows.map((w) => w.seq)) + 1;
    await addMany(
      converted.map((p, index) => ({
        missionId: id,
        seq: startSeq + index,
        lng: Number(p.wgsLng.toFixed(6)),
        lat: Number(p.wgsLat.toFixed(6)),
        coordSystem: sourceCrs,
        sourceLng: Number(p.lng.toFixed(6)),
        sourceLat: Number(p.lat.toFixed(6)),
        altitude: p.altitude ?? batchAltitude,
        speed: 8,
        heading: 90,
        gimbalPitch: -90,
        action: '拍照' as WaypointAction,
        hoverSec: 0,
      })),
    );
    setError('');
    const shifted = converted.filter((p) => Math.abs(p.wgsLng - p.lng) > 1e-7 || Math.abs(p.wgsLat - p.lat) > 1e-7).length;
    setToast(
      `已导入 ${converted.length} 个航点（序号 ${startSeq} 起，来源 ${
        COORD_SYSTEMS.find((c) => c.value === sourceCrs)?.label
      }）${sourceCrs === 'GCJ02' ? `，其中 ${shifted} 个已从 GCJ-02 转换为 WGS-84 入库` : ''}`,
    );
    setPasteText('');
  };

  /** 老数据一键补标：未标来源的航点按 WGS-84 补齐 coordSystem */
  const applyBackfill = async () => {
    const count = await backfillCoordSystem(id, 'WGS84');
    if (count > 0) setToast(`已把 ${count} 个未标来源的老航点补标为 WGS-84`);
  };

  const applyBatchAltitude = async () => {
    for (const w of rows) {
      await update(w.id, { altitude: batchAltitude });
    }
    setToast(`已把 ${rows.length} 个航点的高度统一改为 ${batchAltitude} m`);
  };

  const columns: Columns = [
    { title: '序号', dataIndex: 'seq', width: 70, render: (v: number) => `#${v}` },
    {
      title: '来源坐标系',
      width: 150,
      render: (_: unknown, row: Waypoint) =>
        row.coordSystem ? (
          <Tag color={row.coordSystem === 'GCJ02' ? 'orange' : 'blue'}>
            {row.coordSystem === 'GCJ02' ? 'GCJ-02 高德' : 'WGS-84 无人机'}
          </Tag>
        ) : (
          <Tag color="default">未标注·按WGS-84</Tag>
        ),
    },
    {
      title: '原始经度',
      width: 120,
      render: (_: unknown, row: Waypoint) => (row.sourceLng ?? row.lng).toFixed(6),
    },
    {
      title: '原始纬度',
      width: 120,
      render: (_: unknown, row: Waypoint) => (row.sourceLat ?? row.lat).toFixed(6),
    },
    {
      title: '经度 WGS-84',
      dataIndex: 'lng',
      width: 130,
      render: (v: number) => <strong>{v.toFixed(6)}</strong>,
    },
    {
      title: '纬度 WGS-84',
      dataIndex: 'lat',
      width: 130,
      render: (v: number) => <strong>{v.toFixed(6)}</strong>,
    },
    {
      title: '相对航高 m',
      width: 140,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={20} max={600} value={row.altitude} onChange={(v) => update(row.id, { altitude: Number(v ?? 0) })} />
      ),
    },
    {
      title: '航速 m/s',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={1} max={25} step={0.5} value={row.speed} onChange={(v) => update(row.id, { speed: Number(v ?? 0) })} />
      ),
    },
    {
      title: '航向 °',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={0} max={360} value={row.heading} onChange={(v) => update(row.id, { heading: Number(v ?? 0) })} />
      ),
    },
    {
      title: '云台俯仰 °',
      width: 130,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={-90} max={30} value={row.gimbalPitch} onChange={(v) => update(row.id, { gimbalPitch: Number(v ?? 0) })} />
      ),
    },
    {
      title: '动作',
      width: 120,
      render: (_: unknown, row: Waypoint) => (
        <Select
          size="small"
          style={{ width: 100 }}
          value={row.action}
          onChange={(v) => update(row.id, { action: v as WaypointAction })}
          options={WAYPOINT_ACTIONS.map((a) => ({ value: a, label: a }))}
        />
      ),
    },
    {
      title: '悬停 s',
      width: 110,
      render: (_: unknown, row: Waypoint) => (
        <InputNumber size="small" min={0} max={300} value={row.hoverSec} onChange={(v) => update(row.id, { hoverSec: Number(v ?? 0) })} />
      ),
    },
    {
      title: '视场（宽×航向）m',
      width: 170,
      render: (_: unknown, row: Waypoint) =>
        mission
          ? `${groundCoverage(mission.sensorWidth, row.altitude, mission.focalLength)} × ${groundCoverage(
              mission.sensorHeight,
              row.altitude,
              mission.focalLength,
            )}`
          : '—',
    },
    {
      title: '单点 GSD cm/px',
      width: 140,
      render: (_: unknown, row: Waypoint) =>
        mission ? calcGsd(mission.pixelSize, row.altitude, mission.focalLength) : '—',
    },
    {
      title: '顺序',
      width: 210,
      render: (_: unknown, row: Waypoint, index: number) => (
        <Space size={4}>
          <Button size="small" disabled={index === 0} onClick={() => move(row.id, 'up')}>
            上移
          </Button>
          <Button size="small" disabled={index === rows.length - 1} onClick={() => move(row.id, 'down')}>
            下移
          </Button>
          <span
            draggable
            title="拖拽到目标行可交换顺序"
            style={{ cursor: 'grab', color: '#97a0ad' }}
            onDragStart={() => setPreviewId(row.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => reorder(row.id, previewId)}
          >
            ⣿
          </span>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 150,
      render: (_: unknown, row: Waypoint) => (
        <Space size={4}>
          <Button size="small" onClick={() => setPreviewId(row.id)}>
            预览视场
          </Button>
          <Button size="small" danger onClick={() => remove(row.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航点明细 · {mission.missionNo}
        </Typography.Title>
        <Tag color="green">航点 {rows.length} 个</Tag>
        <Tag>传感器 {mission.sensorWidth}×{mission.sensorHeight} mm / f{mission.focalLength} mm</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/route`}>航线规划</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button danger size="small" onClick={() => clearMission(mission.id)}>
          清空本任务航点
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {unmarkedCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`检测到 ${unmarkedCount} 个未标来源坐标系的老航点，当前按 WGS-84 打开（地图位置可能有偏差）。`}
          description="在表格中编辑任意字段后该行会自动补上 WGS-84 标记；也可点右侧按钮一次性补标后重新保存。"
          action={
            <Button size="small" type="primary" onClick={applyBackfill}>
              一键补标为 WGS-84
            </Button>
          }
        />
      ) : null}

      <Row gutter={14}>
        <Col span={10}>
          <Card size="small" title="经纬度粘贴导入">
            <Space style={{ marginBottom: 8 }}>
              <span>来源坐标系</span>
              <Select<CoordSystem>
                size="small"
                style={{ width: 210 }}
                value={sourceCrs}
                onChange={setSourceCrs}
                options={COORD_SYSTEMS.map((c) => ({ value: c.value, label: c.label }))}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {COORD_SYSTEMS.find((c) => c.value === sourceCrs)?.hint}
              </Typography.Text>
            </Space>
            <Input.TextArea
              rows={6}
              placeholder={'每行一个点，例如：\n116.391200,39.907500\n116.393000,39.906800,150'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <Space style={{ marginTop: 8 }} wrap>
              <Button type="primary" icon={<ImportOutlined />} onClick={importPaste}>
                导入航点
              </Button>
              <Button onClick={() => setPasteText('')}>清空文本</Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {sourceCrs === 'GCJ02'
                  ? '高德点位按 GCJ-02 解析，自动转为 WGS-84 入库，表格保留原始坐标。'
                  : '按 WGS-84 原样入库，原始坐标与入库坐标相同。'}
              </Typography.Text>
            </Space>
            <Alert
              style={{ marginTop: 8 }}
              type="info"
              showIcon
              message="任一行坐标无效、转换后非法或超出测区边界，整批都不会写入，并提示具体行号。"
            />
          </Card>
          <Card size="small" title="批量修改高度" style={{ marginTop: 12 }}>
            <Space>
              <InputNumber min={20} max={600} step={5} value={batchAltitude} onChange={(v) => setBatchAltitude(Number(v ?? 0))} />
              <span>m</span>
              <Button icon={<ThunderboltOutlined />} onClick={applyBatchAltitude} disabled={rows.length === 0}>
                应用到全部航点
              </Button>
            </Space>
          </Card>
          <Card size="small" title="单点视场预览" style={{ marginTop: 12 }}>
            {preview ? (
              <>
                <Descriptions size="small" column={1} colon={false}>
                  <Descriptions.Item label="航点">
                    #{preview.seq}（{preview.lng.toFixed(5)}, {preview.lat.toFixed(5)}）
                    <Tag color="blue" style={{ marginInlineStart: 6 }}>
                      WGS-84{preview.coordSystem === 'GCJ02' ? '（GCJ-02 转换）' : ''}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="航高 / 航速 / 云台">
                    {preview.altitude} m / {preview.speed} m/s / {preview.gimbalPitch}°
                  </Descriptions.Item>
                  <Descriptions.Item label="视场覆盖">
                    旁向 {groundCoverage(mission.sensorWidth, preview.altitude, mission.focalLength)} m × 航向{' '}
                    {groundCoverage(mission.sensorHeight, preview.altitude, mission.focalLength)} m
                  </Descriptions.Item>
                  <Descriptions.Item label="单点 GSD">
                    {calcGsd(mission.pixelSize, preview.altitude, mission.focalLength)} cm/px
                  </Descriptions.Item>
                </Descriptions>
                <Row gutter={8} style={{ marginTop: 8 }}>
                  <Col span={8}>
                    <Statistic title="任务总航程" value={metrics.pathLength} precision={1} suffix="m" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="预计张数" value={metrics.estPhotos} suffix="张" />
                  </Col>
                  <Col span={8}>
                    <Statistic title="预计耗时" value={metrics.estDuration} precision={1} suffix="min" />
                  </Col>
                </Row>
              </>
            ) : (
              <Empty description="暂无航点可预览" imageStyle={{ height: 40 }} />
            )}
          </Card>
        </Col>
        <Col span={14}>
          <Card size="small" title="航点位置（统一 WGS-84 坐标；预览航点高亮）">
            <AmapRouteView
              mission={mission}
              waypoints={rows}
              altitude={preview?.altitude ?? 120}
              height={360}
              highlightSeq={preview?.seq}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small" title="航点表格（原始坐标与转换后 WGS-84 坐标并列；可改高度/航速/航向/云台/动作，支持上下移与拖拽换序）">
        <Table<Waypoint>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1860 }}
          locale={{ emptyText: '暂无航点，请先粘贴导入' }}
        />
      </Card>
    </Space>
  );
}
