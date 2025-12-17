import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Chart, registerables } from "chart.js";
import type { Chart as ChartType, ChartOptions, ChartData } from "chart.js";
Chart.register(...registerables);

/* ========== 误差度量（一步前向 / 留出集） ========== */
function mape(y: number[], yhat: number[]): number {
  const pairs = y
    .map((v, i) => [v, yhat[i]] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a !== 0);
  if (!pairs.length) return NaN;
  const err = pairs.reduce((s, [a, b]) => s + Math.abs((a - b) / a), 0) / pairs.length;
  return err * 100;
}
function rmse(y: number[], yhat: number[]): number {
  const pairs = y
    .map((v, i) => [v, yhat[i]] as const)
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  if (!pairs.length) return NaN;
  const err = Math.sqrt(
    pairs.reduce((s, [a, b]) => s + (a - b) ** 2, 0) / pairs.length
  );
  return err;
}
type MetricName = "MAPE" | "RMSE";
function score(metric: MetricName, y: number[], yhat: number[]): number {
  return metric === "MAPE" ? mape(y, yhat) : rmse(y, yhat);
}

/* ========== 模拟周度数据（2 年，104 周） ========== */
/* ========== 源数据生成（周度 2 年，三种场景） ========== */
type DataProfile = "flat" | "trend" | "season_trend";
/**
 * 生成周度数据：
 * - flat：基线 + 噪声
 * - trend：基线 + 线性趋势 + 噪声
 * - season_trend：基线 + 线性趋势 + 年季节（52周正弦）+ 噪声
 */
function generateWeekly(profile: DataProfile): { dates: Date[]; sales: number[] } {
  const start = new Date("2024-01-07");
  const weeks = 52 * 2;
  const dates: Date[] = [];
  const sales: number[] = [];

  const baseline = 500;
  const trendPerWeek = profile === "flat" ? 0 : 3.0;
  const annualAmp = profile === "season_trend" ? 0.2 : 0.0;

  // 可复现随机
  let seed = 42;
  const rng = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  for (let w = 0; w < weeks; w++) {
    const date = new Date(start.getTime() + w * 7 * 86400000);
    dates.push(date);

    const annual = 1 + annualAmp * Math.sin((2 * Math.PI * w) / 52);
    const trend = trendPerWeek * w;
    const noise = (rng() - 0.5) * 40;
    const y = Math.max(50, (baseline + trend) * annual + noise);

    sales.push(Number(y.toFixed(2)));
  }
  return { dates, sales };
}


/* ========== 方法 1：SMA ========== */
// 平滑（展示）
function calcSMA(values: number[], window: number): number[] {
  const n = values.length;
  if (window <= 1) return values.slice();
  const out = new Array<number>(n).fill(NaN);
  let sum = 0;
  for (let t = 0; t < n; t++) {
    sum += values[t];
    if (t - window >= 0) sum -= values[t - window];
    if (t >= window - 1) {
      out[t] = sum / window; // 只有满窗时才写值
    }
  }
  return out;
}
// 一步前向（用于滚动评估）：预测 t 用 t-1..t-W
function osaSMA(values: number[], window: number): number[] {
  const n = values.length;
  const out = new Array<number>(n).fill(NaN);
  for (let t = 1; t < n; t++) {
    const w = Math.min(window, t);
    let s = 0;
    for (let k = 1; k <= w; k++) s += values[t - k];
    out[t] = s / w;
  }
  return out;
}
// 多步常数预测（用于留出集和可视化）
function forecastSMA(values: number[], window: number, horizon: number): number[] {
  const n = values.length;
  const W = Math.max(1, Math.min(window, n));
  const lastMean = values.slice(n - W).reduce((a, b) => a + b, 0) / W;
  return new Array<number>(horizon).fill(lastMean);
}

/* ========== 方法 2：Holt‑Winters（加法季节，s=52） ========== */
type HWResult = {
  level: number[]; trend: number[]; seasonal: number[]; fit: number[]; yhatOSA: number[];
};
function initSeasonalAdditive(values: number[], s: number): number[] {
  const n = values.length;
  const m = Math.floor(n / s);
  const overallMean = values.reduce((a, b) => a + b, 0) / n;
  const seasonMeans = new Array<number>(s).fill(0);
  const counts = new Array<number>(s).fill(0);

  for (let k = 0; k < m; k++) {
    for (let i = 0; i < s; i++) {
      const idx = k * s + i;
      seasonMeans[i] += values[idx];
      counts[i] += 1;
    }
  }
  for (let i = 0; i < s; i++) {
    if (counts[i] > 0) seasonMeans[i] /= counts[i];
    else seasonMeans[i] = values[i] ?? overallMean;
  }
  for (let i = 0; i < s; i++) seasonMeans[i] = seasonMeans[i] - overallMean;
  return seasonMeans;
}
function holtWintersAdditive(
  values: number[], s: number, alpha: number, beta: number, gamma: number
): HWResult {
  const n = values.length;
  const L = new Array<number>(n).fill(NaN);
  const B = new Array<number>(n).fill(NaN);
  const S = new Array<number>(n).fill(NaN);
  const fit = new Array<number>(n).fill(NaN);
  const yhat = new Array<number>(n).fill(NaN);
  if (n === 0) return { level: L, trend: B, seasonal: S, fit, yhatOSA: yhat };

  const initS = initSeasonalAdditive(values, s);
  L[0] = values[0] - initS[0 % s];

  const initSpan = Math.max(1, Math.min(10, n - 1));
  let diffSum = 0;
  for (let i = 1; i <= initSpan; i++) diffSum += values[i] - values[i - 1];
  B[0] = diffSum / initSpan;

  for (let t = 0; t < Math.min(s, n); t++) S[t] = initS[t];

  for (let t = 1; t < n; t++) {
    const S_prev = t - s >= 0 ? S[t - s] : initS[t % s];
    yhat[t] = L[t - 1] + B[t - 1] + S_prev;
    const Lt = alpha * (values[t] - S_prev) + (1 - alpha) * (L[t - 1] + B[t - 1]);
    const Bt = beta * (Lt - L[t - 1]) + (1 - beta) * B[t - 1];
    const St = gamma * (values[t] - Lt) + (1 - gamma) * S_prev;
    L[t] = Lt; B[t] = Bt; S[t] = St; fit[t] = Lt + Bt + S_prev;
  }
  fit[0] = (L[0] ?? 0) + (B[0] ?? 0) + initS[0];
  return { level: L, trend: B, seasonal: S, fit, yhatOSA: yhat };
}
function forecastHW(
  values: number[], s: number, alpha: number, beta: number, gamma: number, horizon: number
): number[] {
  const { level: L, trend: B, seasonal: S } = holtWintersAdditive(values, s, alpha, beta, gamma);
  const n = values.length;
  const LT = L[n - 1];
  const BT = B[n - 1];

  const lastSeasonal = new Array<number>(s).fill(0);
  const seen = new Array<boolean>(s).fill(false);
  for (let t = n - 1; t >= 0; t--) {
    const pos = t % s;
    if (!seen[pos] && Number.isFinite(S[t])) {
      lastSeasonal[pos] = S[t];
      seen[pos] = true;
    }
    if (seen.every(Boolean)) break;
  }

  return Array.from({ length: horizon }, (_, h) => {
    const pos = (n + h) % s;
    return LT + (h + 1) * BT + lastSeasonal[pos];
  });
}

/* ========== 评估工具：滚动 vs 留出（SMA & HW） ========== */
type EvalMode = "rolling" | "holdout";

function evalRollingAll(
  values: number[],
  W: number,
  alphaHW: number, betaHW: number, gammaHW: number,
  metric: MetricName
) {
  const yhatSMA = osaSMA(values, W);
  const yhatHW = holtWintersAdditive(values, 52, alphaHW, betaHW, gammaHW).yhatOSA;
  return {
    SMA: score(metric, values, yhatSMA),
    HW: score(metric, values, yhatHW),
  };
}

function evalHoldoutAll(
  values: number[],
  H: number,
  W: number,
  alphaHW: number, betaHW: number, gammaHW: number,
  metric: MetricName
) {
  const n = values.length;
  const h = Math.max(1, Math.min(H, n - 1));
  const train = values.slice(0, n - h);
  const test = values.slice(n - h);

  const pSMA = forecastSMA(train, W, h);
  const pHW = forecastHW(train, 52, alphaHW, betaHW, gammaHW, h);

  return {
    SMA: score(metric, test, pSMA),
    HW: score(metric, test, pHW),
  };
}

/* ========== 组件主体（SMA + HW） ========== */
export default function App(): JSX.Element {
  
  /** 源数据选择（新增） */
  const [profile, setProfile] = useState<DataProfile>("season_trend");

  /** 根据选择生成数据（替换原 useMockWeekly） */
  const data = useMemo(() => generateWeekly(profile), [profile]);

  // 参数
  const [W, setW] = useState<number>(8);             // SMA
  const [alphaHW, setAlphaHW] = useState<number>(0.3);
  const [betaHW, setBetaHW] = useState<number>(0.1);
  const [gammaHW, setGammaHW] = useState<number>(0.2);
  const [H, setH] = useState<number>(12);            // 预测期数（同时作为留出长度）
  const seasonLen = 52;


  // 评估面板
  const [evalMode, setEvalMode] = useState<EvalMode>("rolling");
  const [metricName, setMetricName] = useState<MetricName>("MAPE");

  // —— 新增：记录图例隐藏状态（使用稳定 key）——
  type HiddenMap = Record<string, boolean>;
  const [hiddenMap, setHiddenMap] = useState<HiddenMap>({});

  // 图表
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<ChartType | null>(null);

  // 历史拟合（展示）
  const smaFit = useMemo(() => calcSMA(data.sales, W), [data, W]);
  const hwFit = useMemo(
    () => holtWintersAdditive(data.sales, seasonLen, alphaHW, betaHW, gammaHW).fit,
    [data, alphaHW, betaHW, gammaHW]
  );

  // 预测（展示）
  const smaFcast = useMemo(() => forecastSMA(data.sales, W, H), [data, W, H]);
  const hwFcast = useMemo(
    () => forecastHW(data.sales, seasonLen, alphaHW, betaHW, gammaHW, H),
    [data, alphaHW, betaHW, gammaHW, H]
  );

  // 误差面板（滚动 or 留出）
  const metrics = useMemo(() => {
    const y = data.sales;
    return evalMode === "rolling"
      ? evalRollingAll(y, W, alphaHW, betaHW, gammaHW, metricName)
      : evalHoldoutAll(y, H, W, alphaHW, betaHW, gammaHW, metricName);
  }, [data, W, alphaHW, betaHW, gammaHW, evalMode, metricName, H]);

  // 工具：pad 序列到共同时间轴
  const histLabels = useMemo(() => data.dates.map(d => d.toISOString().slice(0, 10)), [data]);
  const futureLabels = useMemo(() => {
    const last = data.dates[data.dates.length - 1];
    const arr: Date[] = [];
    for (let h = 1; h <= H; h++) arr.push(new Date(last.getTime() + h * 7 * 86400000));
    return arr.map(d => d.toISOString().slice(0, 10));
  }, [data, H]);
  const allLabels = useMemo(() => [...histLabels, ...futureLabels], [histLabels, futureLabels]);
  const pad = (arr: number[], leftNaN: number, rightNaN: number) => [
    ...new Array<number>(leftNaN).fill(NaN),
    ...arr,
    ...new Array<number>(rightNaN).fill(NaN),
  ];

  // —— 图例 key 常量（稳定，不随参数变化）——
  const KEY_RAW = "RAW";
  const KEY_SMA_FIT = "SMA_FIT";
  const KEY_SMA_FCST = "SMA_FCST";
  const KEY_HW_FIT = "HW_FIT";
  const KEY_HW_FCST = "HW_FCST";

  // 渲染图表（含隐藏状态持久化）
  useEffect(() => {
    if (!canvasRef.current) return;
    const nHist = data.sales.length;

    const rawHist = pad(data.sales, 0, H);
    const smaHist = pad(smaFit, 0, H);
    const hwHist = pad(hwFit, 0, H);
    const smaPred = pad(smaFcast, nHist, 0);
    const hwPred = pad(hwFcast, nHist, 0);

    // 在 dataset 上加 metaKey（我们自定义的稳定 key）
    const datasets: (ChartData<"line">["datasets"][number] & { metaKey: string })[] = [];

    datasets.push({
        metaKey: KEY_RAW,
        label: "Actual Sales (weekly)",
        data: rawHist,
        hidden: !!hiddenMap[KEY_RAW],
        borderColor: "#808080",
        backgroundColor: "rgba(128,128,128,0.10)",
        borderWidth: 1,
        pointRadius: 0,
        tension: 0,
      } as any);
    

    const cSMA = "#0078D4";
    const cHW = "#A4262C";
    const dashed = [6, 6] as const;

    // 拟合
    datasets.push(
      {
        metaKey: KEY_SMA_FIT,
        label: `SMA Fit (W=${W})`,
        data: smaHist,
        hidden: !!hiddenMap[KEY_SMA_FIT],
        borderColor: cSMA,
        backgroundColor: "rgba(0,120,212,0.10)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
      } as any,
      {
        metaKey: KEY_HW_FIT,
        label: `HW(A) Fit (α=${alphaHW.toFixed(2)}, β=${betaHW.toFixed(2)}, γ=${gammaHW.toFixed(2)}, s=${seasonLen})`,
        data: hwHist,
        hidden: !!hiddenMap[KEY_HW_FIT],
        borderColor: cHW,
        backgroundColor: "rgba(164,38,44,0.10)",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0,
      } as any
    );

    // 预测
    datasets.push(
      {
        metaKey: KEY_SMA_FCST,
        label: `SMA Forecast (H=${H})`,
        data: smaPred,
        hidden: !!hiddenMap[KEY_SMA_FCST],
        borderColor: cSMA,
        backgroundColor: "rgba(0,120,212,0.0)",
        borderWidth: 2,
        borderDash: dashed,
        pointRadius: 0,
        tension: 0,
      } as any,
      {
        metaKey: KEY_HW_FCST,
        label: `HW(A) Forecast (H=${H})`,
        data: hwPred,
        hidden: !!hiddenMap[KEY_HW_FCST],
        borderColor: cHW,
        backgroundColor: "rgba(164,38,44,0.0)",
        borderWidth: 2,
        borderDash: dashed,
        pointRadius: 0,
        tension: 0,
      } as any
    );

    const chartData: ChartData<"line"> = { labels: allLabels, datasets };

    const options: ChartOptions<"line"> = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "top",
          labels: { usePointStyle: true },
          onClick: (_e, legendItem, legend) => {
            // 1) 类型守卫：只有当 datasetIndex 是 number 时才继续
            const idx =
              typeof (legendItem as any).datasetIndex === "number"
                ? ((legendItem as any).datasetIndex as number)
                : -1;
            if (idx < 0) return;

            // 2) 保护 datasets 取值
            const chart = legend.chart;
            const ds = chart?.data?.datasets?.[idx] as any | undefined;
            if (!ds) return;

            // 3) 显式切换 hidden 并更新图表
            ds.hidden = !ds.hidden;
            chart.update();

            // 4) 同步到 React 的 hiddenMap（使用我们在 dataset 上设置的稳定 metaKey）
            const key: string | undefined = ds.metaKey;
            if (key) {
              setHiddenMap(prev => ({ ...prev, [key]: !!ds.hidden }));
            }

          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const y = ctx.parsed.y;
              const val = typeof y === "number" ? y.toLocaleString(undefined, { maximumFractionDigits: 2 }) : y;
              return `${ctx.dataset.label}: ${val}`;
            },
          },
        },
      },
      scales: {
        x: { title: { display: false, text: "Week Date" }, ticks: { maxRotation: 0, autoSkip: true } },
        y: { title: { display: true, text: "Sales" } },
      },
    };

    // 简化处理：仍采取重建实例；隐藏状态由 hiddenMap 复现
    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, { type: "line", data: chartData, options });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [
    data, allLabels, W, alphaHW, betaHW, gammaHW, H,
    smaFit, hwFit, smaFcast, hwFcast, hiddenMap
  ]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial" }}>
      {/* 标题字体缩小 */}
      <h1 style={{ fontSize: 30, lineHeight: 1.25, margin: "0 0 8px 0", fontWeight: 600 }}>
        Forecasting Demo - SMA and HW
      </h1>

      
      {/* 源数据选择（新增） */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 10 }}>
        <div>
          <b>Source Data:</b>{" "}
          <select value={profile} onChange={(e) => setProfile(e.target.value as DataProfile)}>
            <option value="flat">Flat (no season, no trend)</option>
            <option value="trend">Trend only (no season)</option>
            <option value="season_trend">Season + Trend</option>
          </select>
        </div>
      </div>


      {/* 控制面板 */}
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <div style={{ minWidth: 220 }}>
          <label>SMA·W：<b>{W}</b></label><br />
          <input type="range" min={2} max={24} step={1} value={W} onChange={(e) => setW(parseInt(e.target.value, 10))} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label>HW·α：<b>{alphaHW.toFixed(2)}</b></label><br />
          <input type="range" min={0.05} max={0.8} step={0.05} value={alphaHW}
            onChange={(e) => setAlphaHW(parseFloat(e.target.value))} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label>HW·β：<b>{betaHW.toFixed(2)}</b></label><br />
          <input type="range" min={0.01} max={0.5} step={0.01} value={betaHW}
            onChange={(e) => setBetaHW(parseFloat(e.target.value))} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label>HW·γ：<b>{gammaHW.toFixed(2)}</b></label><br />
          <input type="range" min={0.05} max={0.8} step={0.05} value={gammaHW}
            onChange={(e) => setGammaHW(parseFloat(e.target.value))} />
        </div>
        <div style={{ minWidth: 220 }}>
          <label>Forecasting weeks（H）：<b>{H}</b></label><br />
          <input type="range" min={4} max={26} step={1} value={H} onChange={(e) => setH(parseInt(e.target.value, 10))} />
        </div>
        <div style={{ minWidth: 220 }}>
        </div>
      </div>

      {/* 评估模式 & 指标 */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
        <div>
          <b>Evaluation Methods: </b>
          <label style={{ marginLeft: 8 }}>
            <input type="radio" name="evalMode" checked={evalMode === "rolling"} onChange={() => setEvalMode("rolling")} /> Rolling
          </label>
          <label style={{ marginLeft: 8 }}>
            <input type="radio" name="evalMode" checked={evalMode === "holdout"} onChange={() => setEvalMode("holdout")} /> Holdout
          </label>
        </div>
        <div>
          <b>Metrics: </b>
          <label style={{ marginLeft: 8 }}>
            <input type="radio" name="metricName" checked={metricName === "MAPE"} onChange={() => setMetricName("MAPE")} /> MAPE
          </label>
        </div>
        <div>
          <label style={{ marginLeft: 8 }}>
            <input type="radio" name="metricName" checked={metricName === "RMSE"} onChange={() => setMetricName("RMSE")} /> RMSE
          </label>
        </div>
      </div>

      {/* 一步前向 vs 留出 的简要解释
      <div style={{
        fontSize: 12, color: "#666", background: "#f6f6f6",
        border: "1px solid #eee", borderRadius: 6, padding: 8, marginBottom: 8, maxWidth: 980
      }}>
        <div><b>一步前向（Rolling / Walk-forward）</b>：按时间顺序逐期滚动，预测当期仅使用上一期及更早的信息，更贴近上线实况，衡量短期响应与稳定性。</div>
        <div style={{ marginTop: 4 }}><b>留出（Holdout）</b>：用历史到 T−H 训练，冻结后对未来 H 期做多步预测；直接衡量多步预测的质量，适合计划场景。</div>
      </div> */}

      {/* 误差卡片 */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>
        {[
          { name: "SMA", c: "#0078D4", v: metrics.SMA },
          { name: "HW(A)", c: "#A4262C", v: metrics.HW },
        ].map((item) => (
          <div key={item.name} style={{ border: `1px solid ${item.c}`, borderRadius: 8, padding: 12 }}>
            <div style={{ fontWeight: 600, color: item.c, marginBottom: 6 }}>
              {item.name}{evalMode === "rolling" ? "（Rolling）" : `（Holdout: H=${H}）`}
            </div>
            <div>{metricName}: {Number.isFinite(item.v) ? (metricName === "MAPE" ? `${item.v.toFixed(2)}%` : item.v.toFixed(2)) : "—"}</div>
          </div>
        ))}
      </div>


    {/* 图表 */}
    <div style={{ height: "60vh" }}>
      <canvas ref={canvasRef} />
    </div>
    </div>
  );
}