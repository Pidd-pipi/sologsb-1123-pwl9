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
  Tooltip,
  Typography,
  type TableProps,
} from 'antd';
import { ImportOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import { WAYPOINT_ACTIONS, parseWaypointText, type Waypoint, type WaypointAction, type WaypointLineError } from '../types/waypoint';
import { calcGsd, groundCoverage } from '../utils/geoCalc';
import { COORD_SYSTEMS, pointInPolygon, toWgs84, type CoordSystem } from '../utils/coordTransform';

type Columns = NonNullable<TableProps<Waypoint>['columns']>;

/** /missions/:id/waypoints 航点明细：选来源坐标系后粘贴导入、批量改高度、顺序拖拽、单点视场预览 */
export default function WaypointTable() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const legacyIds = useWaypointStore((s) => s.legacyIds);
  const addMany = useWaypointStore((s) => s.addMany);
  const update = useWaypointStore((s) => s.update);
  const move = useWaypointStore((s) => s.move);
  const reorder = useWaypointStore((s) => s.reorder);
  const remove = useWaypointStore((s) => s.remove);
  const clearMission = useWaypointStore((s) => s.removeByMission);

  const mission = missions.find((m) => m.id === id);
  const rows = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );

  const [pasteText, setPasteText] = useState('');
  const [sourceSystem, setSourceSystem] = useState<CoordSystem>('GCJ-02');
  const [batchAltitude, setBatchAltitude] = useState(120);
  const [previewId, setPreviewId] = useState('');
  const [parseErrors, setParseErrors] = useState<WaypointLineError[]>([]);
  const [outsideLines, setOutsideLines] = useState<number[]>([]);
  const [inputError, setInputError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const preview = rows.find((w) => w.id === previewId) ?? rows[0];
  const metrics = useRouteMetrics(id, { ...DEFAULT_ROUTE_PARAMS, altitude: preview?.altitude ?? 120 });

  const importPaste = async () => {
    if (!mission) return;
    setParseErrors([]);
    setOutsideLines([]);
    setInputError('');

    const { points, errors } = parseWaypointText(pasteText);
    if (points.length === 0 && errors.length === 0) {
      setInputError('未解析到有效经纬度：每行应为「经度,纬度[,航高]」');
      return;
    }
    // 转换并检查转换后的 WGS-84 是否落在测区内；任何一行不合格，整批不写入
    const outside = points
      .filter((p) => {
        const [lng, lat] = toWgs84(p.lng, p.lat, sourceSystem);
        return !pointInPolygon([Number(lng.toFixed(6)), Number(lat.toFixed(6))], mission.areaPolygon);
      })
      .map((p) => p.line);

    if (errors.length > 0 || outside.length > 0) {
      setParseErrors(errors);
      setOutsideLines(outside);
      return;
    }

    const startSeq = rows.length === 0 ? 1 : Math.max(...rows.map((w) => w.seq)) + 1;
    await addMany(
      points.map((p, index) => {
        const [wgsLng, wgsLat] = toWgs84(p.lng, p.lat, sourceSystem);
        return {
          missionId: id,
          seq: startSeq + index,
          lng: Number(wgsLng.toFixed(6)),
          lat: Number(wgsLat.toFixed(6)),
          origLng: Number(p.lng.toFixed(6)),
          origLat: Number(p.lat.toFixed(6)),
          source: sourceSystem,
          altitude: p.altitude ?? batchAltitude,
          speed: 8,
          heading: 90,
          gimbalPitch: -90,
          action: '拍照' as WaypointAction,
          hoverSec: 0,
        };
      }),
    );
    setToast(
      sourceSystem === 'GCJ-02'
        ? `已导入 ${points.length} 个航点（GCJ-02 → WGS-84，序号 ${startSeq} 起）`
        : `已导入 ${points.length} 个航点（WGS-84，序号 ${startSeq} 起）`,
    );
    setInputError('');
    setPasteText('');
  };

  const applyBatchAltitude = async () => {
    for (const w of rows) {
      await update(w.id, { altitude: batchAltitude });
    }
    setToast(`已把 ${rows.length} 个航点的高度统一改为 ${batchAltitude} m`);
  };

  const sourceHint = COORD_SYSTEMS.find((s) => s.value === sourceSystem)?.hint ?? '';
  const hasArea = !!mission && mission.areaPolygon.length >= 3;

  const columns: Columns = [
    { title: '序号', dataIndex: 'seq', width: 70, fixed: 'left', render: (v: number) => `#${v}` },
    {
      title: '来源坐标系',
      width: 150,
      render: (_: unknown, row: Waypoint) =>
        legacyIds.includes(row.id) ? (
          <Tooltip title="旧数据未标来源，当前按 WGS-84 打开；编辑本行或重新保存后自动补上来源标记">
            <Tag color="default">WGS-84 · 待补标</Tag>
          </Tooltip>
        ) : (
          <Tag color={row.source === 'GCJ-02' ? 'green' : 'blue'}>{row.source ?? 'WGS-84'}</Tag>
        ),
    },
    {
      title: '原始坐标（导入值）',
      children: [
        {
          title: '原始经度',
          dataIndex: 'origLng',
          width: 120,
          render: (v: number) => (Number.isFinite(v) ? v.toFixed(6) : '—'),
        },
        {
          title: '原始纬度',
          dataIndex: 'origLat',
          width: 120,
          render: (v: number) => (Number.isFinite(v) ? v.toFixed(6) : '—'),
        },
      ],
    },
    {
      title: '入库坐标（WGS-84，航线 / 视场使用）',
      children: [
        { title: 'WGS 经度', dataIndex: 'lng', width: 120, render: (v: number) => v.toFixed(6) },
        { title: 'WGS 纬度', dataIndex: 'lat', width: 120, render: (v: number) => v.toFixed(6) },
      ],
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
      fixed: 'right',
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

  const importBlocked = parseErrors.length > 0 || outsideLines.length > 0;

  if (!mission) {    return (
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
        <Tag color="blue">库内统一 WGS-84</Tag>
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
      {inputError ? <Alert type="warning" showIcon message={inputError} closable onClose={() => setInputError('')} /> : null}
      {importBlocked ? (
        <Alert
          type="error"
          showIcon
          message={`本批航点未写入（共 ${parseErrors.length + outsideLines.length} 行有问题，请修正后重新导入）`}
          description={
            <Space direction="vertical" size={4}>
              {parseErrors.map((e) => (
                <div key={`err-${e.line}`}>
                  <Typography.Text strong>第 {e.line} 行：</Typography.Text>
                  <Typography.Text type="danger">{e.reason}</Typography.Text>
                </div>
              ))}
              {outsideLines.length > 0 ? (
                <div>
                  <Typography.Text strong>
                    第 {outsideLines.join('、')} 行：转换后的 WGS-84 坐标{hasArea ? '超出测区范围' : '无法校验（测区边界缺失）'}
                  </Typography.Text>
                </div>
              ) : null}
            </Space>
          }
          closable
          onClose={() => {
            setParseErrors([]);
            setOutsideLines([]);
          }}
        />
      ) : null}

      <Row gutter={14}>
        <Col span={10}>
          <Card
            size="small"
            title="经纬度粘贴导入"
            extra={
              <Select
                size="small"
                style={{ width: 210 }}
                value={sourceSystem}
                onChange={setSourceSystem}
                options={COORD_SYSTEMS.map((s) => ({ value: s.value, label: s.label }))}
              />
            }
          >
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
              {sourceHint}。入库统一保存为 WGS-84，表格同时保留原始坐标；航线折线与视场使用转换后的 WGS-84 位置。
              {hasArea ? '转换后超出测区的行将整批拒收。' : '（任务未设置测区边界，暂不做区内校验）'}
            </Typography.Paragraph>
            <Input.TextArea
              rows={6}
              placeholder={'每行一个点，例如：\n116.397490,39.908820\n116.399290,39.908120,150'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <Space style={{ marginTop: 8 }}>
              <Button type="primary" icon={<ImportOutlined />} onClick={importPaste}>
                导入航点
              </Button>
              <Button onClick={() => setPasteText('')}>清空文本</Button>
            </Space>
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
                    #{preview.seq}（WGS-84 {preview.lng.toFixed(5)}, {preview.lat.toFixed(5)}）
                    {preview.source === 'GCJ-02' ? (
                      <Tag color="green" style={{ marginLeft: 6 }}>
                        原始 GCJ-02 {preview.origLng.toFixed(5)}, {preview.origLat.toFixed(5)}
                      </Tag>
                    ) : null}
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
          <Card size="small" title="航点位置（WGS-84，预览航点高亮）">
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

      <Card size="small" title="航点表格（原始坐标保留备查，航线按 WGS-84 绘制；可改高度/航速/航向/云台/动作，支持上下移与拖拽换序）">
        <Table<Waypoint>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 2100 }}
          locale={{ emptyText: '暂无航点，请先选择来源坐标系并粘贴导入' }}
        />
      </Card>
    </Space>
  );
}
