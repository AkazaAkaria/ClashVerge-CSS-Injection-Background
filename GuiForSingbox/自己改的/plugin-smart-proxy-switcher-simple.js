/*
 * 节点智能切换（v1.7 · 运行时架构重构版）
 *
 * v1.7 定位：不重新发明“怎么选节点”，只解决长期后台运行时：
 *   1. 谁还有资格继续执行；
 *   2. 谁的数据仍然有效；
 *   3. 谁的请求应该被取消。
 *
 * 与 v1.6 的关系：
 *   - 保留 v1.6 的节点选择算法：EWMA / 稳定率 / 惩罚 / 暖机 / 延迟滞后 / 冷却 / 每小时切换上限；
 *   - 保留 provider healthcheck → /proxies/{id}/delay 回退；
 *   - 保留全池检测 + 当前节点快速健康检测两级检测；
 *   - 保留数据版本驱动 UI、shallowRef、一次性 Modal 生命周期；
 *   - 重新组织 ProxyManager / ProxyServer / ProbeCoordinator / CoreAdapter。
 *
 * v1.7 核心变化：
 *   A. Runtime Generation：每次 Start / Reconfigure / Stop 都产生新的运行代际。
 *      旧代际的定时器、请求、切换回读即使晚到，也没有资格写入当前运行态。
 *   B. AbortController：停止、重新配置、核心停止时主动取消当前所有 fetch 等待。
 *   C. Probe Token：每个节点每次探测都有独立 token，token 记录 generation、metricVersion、probeSeq、
 *      testUrl；节点被删除 / 端点变化 / 新探测开始后，旧结果自动失效。
 *   D. Metric Lifecycle：ProxyServer 只负责指标生命周期，不负责网络请求；节点身份或探测端点改变时重置指标。
 *   E. ProbeCoordinator：只负责“怎么探测”，不直接改 EWMA / failure / penalty / circuit state。
 *   F. CoreAdapter：统一封装 GUI.for.SingBox 当前使用的官方插件 API，ProxyManager 不再散落读取内核 store / 调宿主 API。
 *   G. Scheduling Isolation：每个 Manager 的定时器都绑定自己的 runToken，旧 timer 无法给新运行代际续命。
 *   H. Switch Isolation：切换调用本身无法被宿主 API 中断时，仍用代际守卫阻止它返回后的旧状态写入；回读等待支持 AbortSignal。
 *
 * 默认运行参数兜底与当前配置保持一致：
 *   并发检测数量 = 10
 *   全节点检测间隔 = 180000ms
 *   节点健康检测超时 = 5000ms
 *
 * v1.7-patch3（基线 = plugin-smart-proxy-switcher.v1.7-patch2-fixed.js）：
 *   I. 解除 tick / tickCurrent 跨类互斥：两类检测的工作集本就不重叠，双向互斥只会白丢检测轮次
 *      （全池轮次被快检吃掉、快检轮次被全池吃掉，两者都让实际检测频率低于配置值）；
 *   J. 故障切换独立冷却 failoverCooldownMs：不再「不限速」，也不再被普通延迟冷却捆住；
 *   K. UI 分数列改用数值排序键 scoreValue，修掉 Number('-') = NaN 造成的排序不稳定。
 *
 * 注意：onReady / onCoreStarted / onCoreStopped 需要注册表 triggers 声明。
 */

const SPS_TAG = '[节点智能切换]'
const SPS_NOTIFY_KEY = 'smart-proxy-switcher.notified.v1'
/*
 * PATCH4-M1：Probe 逐条日志的开关。
 * ★ 不新增宿主配置键 —— 本插件的 configuration 由 `plugins.yaml` 管理，而该文件被 App 整份回写
 *   （见项目 MEMORY「plugins.yaml 被 App 整份回写」），手加的配置项会被抹掉。
 *   改用 localStorage：控制台执行
 *     localStorage.setItem('smart-proxy-switcher.debugProbeLog','1')
 *   后重启插件即开启；改回任意其它值即关闭。
 * 默认关闭：本机 239 节点 / 120s 间隔下开着它约产生 17~26 万条/天。
 */
const SPS_DEBUG_PROBE_LOG_KEY = 'smart-proxy-switcher.debugProbeLog'
const UI_TITLE = '节点智能切换'

/*
 * PATCH4-M7：宿主 handleUseProxy 没有取消能力。
 * 它一旦挂死，switching 会长期为真 ⇒ tick 的 switching 守卫整轮跳过；
 * 而失败切换进的 pendingSwitch 又只由 switchTo 的 finally 消费
 * ⇒ 「快检能测出故障，但永远切不动」。
 * 超时值 = waitForCurrent 总时长（12 × 200ms = 2400ms）+ 余量。
 */
const SELECT_PROXY_TIMEOUT_MS = 3000

const STATUS_RUNNING = 1
const STATUS_STOPPED = 0
const STATUS_ERROR = 2

// 宿主契约：Plugin 上唯一可写的键是 status，写入后宿主会回写注册表（plugins.yaml）。
// 必要性：钩子返回值只能反映「同步返回那一刻」的状态；而自动接管可能是延后发生的
//（onReady 在内核未起时先返回 0，真正的 start() 是之后在定时器里跑的）⇒ 不主动写 status，
// 注册表会一直停在 0，表现为「控制台明明在跑、yaml 里却显示停止」。
const setPluginStatus = (s) => {
  try {
    Plugin.status = s
  } catch (e) {
    /* 少数宿主不放行则忽略，不影响监测功能 */
  }
}

const NUM_SPEC = {
  ewmaAlpha: { def: 0.3, min: 0.05, max: 1 },
  failureThreshold: { def: 4, min: 1, max: 50, int: true },
  circuitBreakerTimeout: { def: 120000, min: 5000, max: 3600000 },
  penaltyIncrement: { def: 5, min: 0, max: 1000 },
  penaltyDecayRate: { def: 0.002, min: 0, max: 1 },
  priorityWeight: { def: 1, min: 0, max: 100 },
  latencyWeight: { def: 100, min: 0, max: 1000 },
  penaltyWeight: { def: 1, min: 0, max: 100 },
  hysteresisMargin: { def: 20, min: 1, max: 10000 },
  stabilityWeight: { def: 50, min: 0, max: 1000 },
}

/*
 * PATCH5-5：惩罚值上限。
 * penaltyDecayRate 的 min 是 0（用户可填 0）⇒ 惩罚只增不减 ⇒ 长期故障节点分数被无限拉低。
 * ★ 只加上限、不抬高 decayRate 的下限 —— 后者会改变所有节点既有的衰减尺度。
 */
const PENALTY_MAX = 1000

const PRESET_KEY = {
  Stable: 'StableMode',
  LatencyFirst: 'LatencyFirstMode',
  Custom: 'CustomMode',
}

const STABILITY_WINDOW = 20
const WARMUP_SUCCESS_SAMPLES = 2
const CURRENT_CHECK_INTERVAL_DEFAULT = 30 * 1000
const CURRENT_FAILURE_THRESHOLD_DEFAULT = 2

/*
 * PATCH6-M1 暖机加速窗口。
 *
 * 背景：healthyPool() 要求每个节点有 WARMUP_SUCCESS_SAMPLES(2) 次成功样本，
 * 而 checkAll 明确排除 current ⇒ 非 current 节点每完成一轮才 +1 ⇒ 需要 2 轮全池检测。
 * 递归 setTimeout 的**实际周期 = 单轮耗时 + monitorIntervalMs**，本机单轮 100s+ ⇒ 实际 4~5 分钟。
 * ⇒ 每次 App 重启 / 内核重启 / 配置保存后，都有 8~10 分钟「无候选空窗」：
 * healthyPool() 恒为 []，首次接管 / 故障转移 / 延迟更优三条路径全部静默跳过。
 *
 * 修法：暖机尚未完成的前几轮不排满 monitorIntervalMs（只改节奏，不改任何判定），
 * 让候选节点尽早出现。
 *
 * ★ 必须同时设「轮数上限」和「时间上限」两个闸门：
 *   任何一个组里只要有**一个永久不可用**的节点（永久故障 / 长期熔断），“暖机完成”条件
 *   就永远不成立 ⇒ 无条件加速会退化成永久满速全池探测（239 节点反复打）。
 *   两个闸门任一触及即回到常规节奏 —— 这是防御，不是常态路径。
 */
const WARMUP_FAST_INTERVAL_MS = 5 * 1000
const WARMUP_FAST_MAX_ROUNDS = 6
const WARMUP_FAST_WINDOW_MS = 10 * 60 * 1000

// PATCH2-P4 Circuit Protection
// 当前节点快速检测的“抖动窗口”下限：窗口外的旧失败不计入连续失败
const CURRENT_FAILURE_WINDOW_DEFAULT = 60 * 1000
// 故障类切换（可插队、不被普通切换覆盖）的原因特征
const FAILOVER_REASON_RE = /失败|熔断|故障|不可用|中断|异常|超时|掉线/
/*
 * PATCH3-P2 故障切换独立冷却。
 * 原版故障路径只查 canSwitch()，完全不限速：按实测配置（快检 30s / 阈值 2 / 窗口 60s）
 * 最快 60s 就能烧掉一次额度 ⇒ 10 分钟内耗尽 maxSwitchPerHour，此后整小时**静默罢工**。
 * 取值必须显著大于「快检触发周期」（阈值 × 检测间隔，默认 2 × 30s = 60s），
 * 也要留出让新节点被快检验证的时间，否则只是把「切太慢」换成「切太勤」。
 */
const FAILOVER_COOLDOWN_DEFAULT = 180 * 1000

const RUNTIME_DEFAULTS = {
  monitorIntervalMs: 180000,
  probeTimeoutMs: 5000,
  concurrency: 10,
}

const BUILTIN_NAME_RE = /^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE|GLOBAL)$/i
const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204'

const clampNum = (value, spec) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return spec.def
  const x = Math.min(spec.max, Math.max(spec.min, n))
  return spec.int ? Math.round(x) : x
}

/*
 * PATCH5-2：把「数组 / 字符串」两种写法统一成数组。
 * 宿主的 InputList 控件返回数组，但手改 plugins.yaml 时可能写成字符串
 * ⇒ 旧版直接当空数组 ⇒ 抛「是空的，请先填写」⇒ 明明填了却报没填（误导）。
 */
const toStringList = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return value.split(/[\r\n,，、]+/)
  return []
}

const isListLike = (value) => Array.isArray(value) || typeof value === 'string'

const sleepWithSignal = (ms, signal) => {
  if (signal?.aborted) return Promise.reject(createCancelledError())
  return new Promise((resolve, reject) => {
    let timer = null
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      reject(createCancelledError())
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(
      () => {
        signal?.removeEventListener?.('abort', onAbort)
        resolve()
      },
      Math.max(0, Number(ms) || 0),
    )
  })
}

const createCancelledError = () => {
  const error = new Error('RUNTIME_CANCELLED')
  error.cancelled = true
  return error
}

/**
 * 同一个提示只弹一次 —— PATCH5-1 起带**时间窗**。
 * 内存指纹 + localStorage 两边都存「上次弹出时间」；两边都设置上限，避免长期运行无限增长。
 * ★ 不要改成「按 runtimeGeneration 重置」：每次重启都会把全部告警重弹一遍。
 */
const notifyOnce = (fingerprint, emit) => {
  const now = Date.now()

  /*
   * 窗口内只弹一次，窗口外允许再弹。
   * 旧版是「见过一次就永远不再弹」⇒「全池不可用」提醒过一次后，恢复再出问题就彻底沉默，
   * 用户会以为插件静默罢工。
   */
  const lastAt = notifyOnce.memory.get(fingerprint)
  if (lastAt && now - lastAt < NOTIFY_WINDOW_MS) return false
  /*
   * PATCH7-W2：此处**不再**立刻写内存时间戳，改到落盘层之后、emit() 之前（见下方）。
   * 原写法会把抑制窗口往后顺延：当内存层被重启清空、而落盘层记录仍在 30 分钟窗内时，
   * 本次调用走到 L221 就被 return —— **既没弹窗，却已经把内存时间戳刷新了**，
   * 于是真正的起点从「最后一次弹出」变成了「最后一次调用」（最坏 +30 分钟）。
   * 形态与 patch5 专门要修的那类「该弹的时候不弹」同源。
   */

  /*
   * 下面的淘汰块原本在 L205 之后（写入后立刻维护上限）。
   * PATCH7-W2 把「写入」挪到本函数末尾了 ⇒ **淘汰必须跟着一起挪**，不能留在原地，
   * 否则它会在写入之前运行、每次少淘汰一个，上限会被慢慢顶穿。
   * （MEMORY 2.21：离开每一步都要问「以前是什么」—— 挪走一个语句时要看谁依赖它的位置。）
   */
  try {
    const store = JSON.parse(localStorage.getItem(SPS_NOTIFY_KEY) || '{}')
    const savedAt = Number(store[fingerprint]) || 0
    if (savedAt && now - savedAt < NOTIFY_WINDOW_MS) return false
    store[fingerprint] = now
    const keys = Object.keys(store)
    if (keys.length > 200) {
      keys
        .sort((a, b) => Number(store[a]) - Number(store[b]))
        .slice(0, keys.length - 200)
        .forEach((key) => delete store[key])
    }
    localStorage.setItem(SPS_NOTIFY_KEY, JSON.stringify(store))
  } catch (e) {
    // localStorage 不可用时，内存指纹仍然有效。
  }

  /*
   * PATCH7-W2：两层都放行之后才写内存时间戳。
   * ⇒ 内存时间戳的语义回到「最后一次**弹出**时间」，与落盘层同口径（MEMORY 2.5「比较基准必须同口径」）。
   * ★ 顺序要求：必须在 try 之后（被落盘层 return 时不会走到这里），必须在 emit() 之前（先记账再弹）。
   */
  notifyOnce.memory.set(fingerprint, now)

  /*
   * PATCH7-W2：与 set 的相对顺序保持原样（写入 → 超限则淘汰）。
   * 淘汰按时间戳而非插入顺序：Map 的 set 对已存在的 key 不改变插入顺序，
   * 而窗口外重弹会刷新时间戳 ⇒ 按插入顺序淘汰会误删「最近还弹过」的指纹。
   */
  if (notifyOnce.memory.size > NOTIFY_MEMORY_CAP) {
    const stale = [...notifyOnce.memory.entries()].sort((a, b) => a[1] - b[1]).slice(0, notifyOnce.memory.size - NOTIFY_MEMORY_CAP)
    for (const entry of stale) notifyOnce.memory.delete(entry[0])
  }

  emit()
  return true
}
notifyOnce.memory = new Map()
const NOTIFY_MEMORY_CAP = 500
const NOTIFY_WINDOW_MS = 30 * 60 * 1000

// PATCH4-M1：Probe 逐条日志开关（见 SPS_DEBUG_PROBE_LOG_KEY 的注释）
const isDebugProbeLog = () => {
  try {
    return localStorage.getItem(SPS_DEBUG_PROBE_LOG_KEY) === '1'
  } catch (e) {
    return false
  }
}

let pushDataVersion = null
/*
 * PATCH3-P3：UI 排序专用哨兵。
 * 不可用节点的 getScore() 恒为 -Infinity，一旦进比较器就是 Infinity - Infinity = NaN ⇒
 * Array.prototype.sort 在比较器返回 NaN 时结果不保证稳定，不可用节点位置会随机跳动。
 */
const SCORE_UNAVAILABLE = -1e9
const notifyDataChanged = () => {
  if (pushDataVersion) pushDataVersion()
}

const buildRowSets = (managers, now) =>
  managers.map((manager) => ({
    group: manager.group,
    rows: manager.proxies.map((proxy) => {
      // PATCH3-P3：分数只取一次 —— 显示用字符串、排序用数值，两者同源不会漂移
      const rawScore = proxy.getScore()
      let testHost = '-'
      try {
        testHost = proxy.lastTestUrl ? new URL(proxy.lastTestUrl).hostname : '-'
      } catch (e) {
        testHost = '-'
      }

      return {
        _selected: !!(manager.current && manager.current.id === proxy.id),
        id: proxy.id,
        state: proxy.state,
        lastDelay: Number.isFinite(proxy.lastDelay) ? proxy.lastDelay.toFixed(2) + 'ms' : '-',
        ewmaLatency: Number.isFinite(proxy.ewmaLatency) ? proxy.ewmaLatency.toFixed(2) + 'ms' : '-',
        testHost,
        score: Number.isFinite(rawScore) ? rawScore.toFixed(2) : '-',
        // PATCH3-P3：排序键是数值，不解析显示字符串（Number('-') = NaN）
        scoreValue: Number.isFinite(rawScore) ? rawScore : SCORE_UNAVAILABLE,
        failureCount: proxy.failureCount,
        penalty: proxy.decayedPenalty(now).toFixed(2),
        // PATCH2-P3 Metric Isolation：两个容器都要可见，否则新字段只写不读就是死字段，
        // 也无法在真机上验证「快速检测没有污染评分系统」。
        fullProbeSample: (proxy.fullProbeMetric ? proxy.fullProbeMetric.okCount : 0) + '/' + (proxy.fullProbeMetric ? proxy.fullProbeMetric.failCount : 0),
        currentProbeStreak: (proxy.currentProbe ? proxy.currentProbe.fastFailureCount : Number(proxy.fastFailureCount) || 0) + ' 连败',
        isAvailable: proxy.state === 'CLOSED' ? '✅' : proxy.state === 'HALF_OPEN' ? '🟡' : '❌',
        lastPenaltyUpdate: proxy.lastPenaltyUpdate,
        nextAttempt: proxy.nextAttempt,
      }
    }),
  }))

const readPreset = (config, presetName) => {
  const raw = config[PRESET_KEY[presetName]]
  let obj = {}

  if (typeof raw === 'string' && raw.trim()) {
    try {
      obj = JSON.parse(raw)
    } catch (e) {
      console.warn(SPS_TAG, `预设【${presetName}】JSON 解析失败，本次改用内置默认值：`, e.message || e)
      obj = {}
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw
  }

  const out = {}
  for (const key of Object.keys(NUM_SPEC)) out[key] = clampNum(obj[key], NUM_SPEC[key])
  return out
}

/**
 * CoreAdapter
 *
 * 只做宿主 / 内核 API 适配，不保存运行期决策状态。
 * ProxyManager 不再直接操作 kernel store 或调用 Plugins.handleUseProxy。
 */
class CoreAdapter {
  constructor() {
    this.appTitle = String((Plugins && Plugins.APP_TITLE) || '')
  }

  isSingBox() {
    return this.appTitle.includes('SingBox')
  }

  getStore() {
    return Plugins.useKernelApiStore()
  }

  isRunning() {
    try {
      return !!this.getStore()?.running
    } catch (e) {
      return false
    }
  }

  getProfile() {
    try {
      return Plugins.useProfilesStore()?.currentProfile || null
    } catch (e) {
      return null
    }
  }

  getApiContext() {
    const fallbackPort = this.isSingBox() ? 20123 : 20113
    let port = fallbackPort
    let secret = ''

    try {
      const profile = this.getProfile()
      if (profile) {
        const ctrl = this.isSingBox() ? profile.experimental?.clash_api?.external_controller : profile.advancedConfig?.['external-controller']
        if (ctrl) {
          const raw = String(ctrl).trim()
          const candidate = Number(raw.split(':').pop())
          if (Number.isFinite(candidate) && candidate > 0) port = candidate
        }

        secret = this.isSingBox() ? profile.experimental?.clash_api?.secret || '' : profile.advancedConfig?.secret || ''
      }
    } catch (e) {
      console.warn(SPS_TAG, '读取内核凭据失败，使用默认端口：', e.message || e)
    }

    return {
      base: 'http://127.0.0.1:' + port,
      bearer: String(secret || ''),
    }
  }

  getGroup(groupName) {
    try {
      return this.getStore()?.proxies?.[groupName] || null
    } catch (e) {
      return null
    }
  }

  getCurrentId(groupName) {
    const group = this.getGroup(groupName)
    if (!group) return undefined
    return typeof group.now === 'string' ? group.now : group.now == null ? null : String(group.now)
  }

  isSelector(groupName) {
    const group = this.getGroup(groupName)
    return !!group && String(group.type || '').toLowerCase() === 'selector'
  }

  /**
   * 获取策略组下真实叶子节点及探测端点。
   * 返回 null = 组不存在；[] = 组存在但当前没有可测速节点。
   */
  listNodes(groupName) {
    let store = null
    try {
      store = this.getStore()
    } catch (e) {
      return null
    }

    const group = store?.proxies?.[groupName]
    if (!group || !Array.isArray(group.all)) return null

    return (
      group.all
        .filter((id) => id && id !== groupName && !BUILTIN_NAME_RE.test(id))
        // PATCH4-M3：同一 id 重复出现时 syncNodes 会按 id 复用同一个 ProxyServer 并 push 两次 ⇒
        // 同 kind 探测真重叠（这正是 M4 那条竞态的唯一可达路径）、UI 重复行、重复探测。保留首次出现。
        .filter((id, index, array) => array.indexOf(id) === index)
        .map((id) => ({ id, node: store.proxies?.[id] }))
        .filter(({ node }) => node && !Array.isArray(node.all))
        .map(({ id, node }) => {
          const direct = '/proxies/' + encodeURIComponent(id) + '/delay'
          const provider = node.provider ? '/providers/proxies/' + encodeURIComponent(node.provider) + '/' + encodeURIComponent(id) + '/healthcheck' : null

          return {
            id,
            group: groupName,
            primaryPath: provider || direct,
            fallbackPath: provider ? direct : null,
          }
        })
    )
  }

  /**
   * 使用宿主官方切换 API。
   * v1.7 不再由 Manager 构造底层 PUT；官方 API 变更只需要在这里适配。
   */
  async selectProxy(groupName, nodeId) {
    const group = this.getGroup(groupName)
    const target = this.getStore()?.proxies?.[nodeId]

    if (!group || !target) {
      throw new Error(`组或节点不存在（${groupName} / ${nodeId}）`)
    }
    if (!this.isSelector(groupName)) {
      throw new Error(`策略组【${groupName}】不是 Selector 组（type=${group.type || 'unknown'}）`)
    }
    if (typeof Plugins.handleUseProxy !== 'function') {
      throw new Error('宿主未提供 Plugins.handleUseProxy()，无法执行节点切换')
    }

    return await Plugins.handleUseProxy(group, target)
  }
}

/**
 * ProbeCoordinator
 *
 * 只负责“探测请求生命周期”：
 *   - URL / endpoint 回退；
 *   - AbortSignal 联动；
 *   - 单请求 timeout；
 *   - 并发控制。
 *
 * 严禁在此处写 ProxyServer 的任何指标。
 */
/**
 * PATCH2-P0 Abort Chain
 *
 * 合并多个 AbortSignal，返回**可回收**的合并信号。
 * ★ 必须 dispose：runtime signal 长期存活，挂上去的 listener 不移除会随探测次数无限累积。
 */
const mergeSignals = (...signals) => {
  const controller = new AbortController()

  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }

  const cleanups = []

  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
    cleanups.push(() => signal.removeEventListener?.('abort', abort))
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    },
  }
}

/**
 * ProbeCoordinator
 *
 * 只负责“探测请求生命周期”：
 *   - URL / endpoint 回退；
 *   - AbortSignal 联动（runtime + probe token 三级合并）；
 *   - 单请求 timeout；
 *   - 并发控制。
 *
 * 严禁在此处写 ProxyServer 的任何指标。
 */
class ProbeCoordinator {
  constructor(coreAdapter) {
    this.core = coreAdapter
  }

  createRequestController(parentSignal, timeoutMs) {
    const controller = new AbortController()
    let timer = null
    let onParentAbort = null

    if (parentSignal) {
      onParentAbort = () => controller.abort()
      if (parentSignal.aborted) controller.abort()
      else parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }

    const delay = Math.max(1, Number(timeoutMs) || 1)
    timer = setTimeout(() => controller.abort(), delay)

    return {
      signal: controller.signal,
      dispose: () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        if (parentSignal && onParentAbort) parentSignal.removeEventListener?.('abort', onParentAbort)
      },
    }
  }

  async probePath(path, testUrl, timeoutMs, signal) {
    if (signal?.aborted) throw createCancelledError()

    const api = this.core.getApiContext()
    const qs = new URLSearchParams({
      url: testUrl,
      timeout: String(timeoutMs),
    })
    // PATCH5-4：secret 若已带 Bearer 前缀，旧版会拼成 "Bearer Bearer xxx" ⇒ 401 ⇒ 全池探测失败，
    // 症状看起来像「所有节点都挂了」。
    const bearerToken = String(api.bearer || '')
      .replace(/^Bearer\s+/i, '')
      .trim()
    const headers = bearerToken ? { Authorization: 'Bearer ' + bearerToken } : {}
    const linked = this.createRequestController(signal, timeoutMs)

    try {
      if (linked.signal.aborted) throw createCancelledError()

      const response = await fetch(api.base + path + '?' + qs.toString(), {
        method: 'GET',
        headers,
        signal: linked.signal,
      })

      if (signal?.aborted) throw createCancelledError()
      if (!response.ok) {
        /*
         * PATCH4-M9：内核的 504 是「等满 RequestTimeout 才回来」的（实测 timeout=5000 → 5015ms），
         * 响应体里的 message 才是唯一有效信息；旧版直接抛 `HTTP 504`，
         * 排查时只剩一个无信息量的状态码。
         */
        let detail = ''
        try {
          const body = await response.json()
          if (body?.message) detail = '：' + body.message
        } catch (e) {
          // 响应体不是 JSON ⇒ 退回纯状态码
        }
        const error = new Error('HTTP ' + response.status + detail)
        // 401 / 403 = clash_api 凭据问题，责任不在节点
        if (response.status === 401 || response.status === 403) error.controlPlane = true
        throw error
      }

      const data = await response.json()
      if (signal?.aborted) throw createCancelledError()

      const delay = Number(data?.delay)
      if (!Number.isFinite(delay) || delay <= 0) throw new Error('无有效 delay')
      return delay
    } catch (error) {
      /*
       * PATCH4-M9：探测请求打到的是**本机内核的 clash_api**，不是节点本身。
       * 所以 fetch 层的失败（TypeError: Failed to fetch / 连接被拒）永远是控制面问题，
       * 与节点好坏无关 ⇒ 打标后不计 penalty，避免「内核 API 挂了 ⇒ 全池被判故障」。
       */
      if (!error?.cancelled && !error?.controlPlane && (error instanceof TypeError || /fetch|network/i.test(String(error?.message || '')))) {
        error.controlPlane = true
      }
      throw error
    } finally {
      linked.dispose()
    }
  }

  /**
   * 单节点探测：优先 primary，失败再 fallback。
   * 只有真正成功才返回 ok=true；取消永远单独标记，不得被记录成失败样本。
   *
   * PATCH2-P0：★token.signal 与 runtime signal 一起挂到 fetch 上。
   *   三级取消闭环：Runtime stop → runtime signal；节点删除 / 端点变化 / 新一轮探测 → token.signal；
   *   单请求超时 → request controller。
   */
  async probe(proxy, testUrl, timeoutMs, signal, token) {
    const merged = mergeSignals(signal, token?.signal)

    try {
      if (merged.signal.aborted) return { ok: false, cancelled: true }

      const urls = proxy.getProbePaths()
      for (let index = 0; index < urls.length; index++) {
        const path = urls[index]
        if (!path) continue

        try {
          const delay = await this.probePath(path, testUrl, timeoutMs, merged.signal)
          return {
            ok: true,
            cancelled: false,
            delay,
            path,
            usedFallback: index > 0,
          }
        } catch (error) {
          if (merged.signal.aborted || signal?.aborted || token?.signal?.aborted || error?.cancelled) {
            return { ok: false, cancelled: true }
          }
          if (index === urls.length - 1) {
            return {
              ok: false,
              cancelled: false,
              delay: 0,
              path,
              // PATCH4-M9：控制面失败（内核 API 连不上 / 凭据错）不计入节点失败统计
              controlPlane: !!error?.controlPlane,
              error: error?.message || String(error),
            }
          }
        }
      }

      return {
        ok: false,
        cancelled: false,
        delay: 0,
        error: '没有可用探测端点',
      }
    } finally {
      merged.dispose()
    }
  }

  /**
   * 自己维护并发 worker，而不是依赖宿主 asyncPool：
   * 这样停止 / 重配置时，worker 可以明确观察 session AbortSignal，后续任务不会继续启动。
   * ★PATCH2-P0：每个任务结束都必须 releaseProbeController，否则长期运行会累积 controller。
   */
  async probeMany(proxies, testUrl, timeoutMs, concurrency, signal, generation, managerGeneration, debugProbeLog) {
    const list = Array.isArray(proxies) ? proxies.slice() : []
    if (list.length === 0 || signal?.aborted) return []

    const limit = Math.max(1, Math.min(list.length, Number(concurrency) || 1))
    const results = new Array(list.length)
    let cursor = 0

    const worker = async () => {
      while (!signal?.aborted) {
        const index = cursor++
        if (index >= list.length) return

        const proxy = list[index]
        // PATCH7-W4：token 提到外层，保证 finally 一定能释放（见下方 catch 说明）
        let token = null

        try {
          token = proxy.beginProbe({
            kind: 'full',
            testUrl,
            generation,
            managerGeneration,
          })

          // PATCH4-M1：逐条 Probe 日志改为开关控制（默认关）。保留它是因为「删除节点后旧 Probe 是否还能回写」这类问题只能靠它观测。
          const probeStartedAt = debugProbeLog ? Date.now() : 0
          if (debugProbeLog) console.log(SPS_TAG, `Probe开始：组=${proxy.group}，节点=${proxy.id}，类型=full，generation=${generation}`)

          const result = await this.probe(proxy, testUrl, timeoutMs, signal, token)

          if (debugProbeLog) {
            const probeCostMs = Date.now() - probeStartedAt
            const probeState = result?.cancelled ? '取消' : result?.ok ? `成功 ${Math.round(result.delay)}ms` : `失败${result?.error ? `：${result.error}` : ''}`
            console.log(SPS_TAG, `Probe完成：组=${proxy.group}，节点=${proxy.id}，${probeState}，耗时=${probeCostMs}ms，generation=${generation}`)
          }

          results[index] = { proxy, token, result }
        } catch (error) {
          /*
           * PATCH7-W4：这里原本只有 try/finally，**没有 catch**。
           * 异常会冒泡到下面的 Promise.allSettled 被静默吞掉（allSettled 永远不 reject）
           * ⇒ 该节点本轮「既没成功也没失败」，UI 上表现为长期没有 EWMA，日志里一行线索都没有。
           * 取消是正常路径（删除节点 / 停止 runtime），不打日志。
           */
          if (!error?.cancelled) {
            console.warn(SPS_TAG, `全池探测 worker 异常：组=${proxy.group}，节点=${proxy.id}`, error?.message || error)
          }
        } finally {
          // PATCH4-M4：传 token.controller 做持有者校验
          if (token) proxy.releaseProbeController(token.key, token.controller)
        }
      }
    }

    const workers = []
    for (let i = 0; i < limit; i++) workers.push(worker())
    await Promise.allSettled(workers)

    /*
     * PATCH7-W4：再补一道「本轮有没有节点没产出结果」的检测。
     * results[index] 只在成功路径写入 ⇒ 任何早退都会让它留空，并被 filter(Boolean) 悄悄丢掉。
     * 这是「个别节点长期不更新」的唯一可观测入口 —— 光有上面的 catch 还不够：
     * 若异常发生在 results[index] 赋值**之前**且被吞掉，仍然需要一个总账层面的确认。
     * ★ 已取消时不告警：那种情况整轮作废属预期行为。
     */
    if (!signal?.aborted) {
      const missing = []
      for (let i = 0; i < list.length; i++) if (!results[i]) missing.push(list[i].id)
      if (missing.length > 0) {
        const shown = missing.slice(0, 5).join(' / ')
        console.warn(SPS_TAG, `本轮全池探测有 ${missing.length}/${list.length} 个节点未产出结果：${shown}${missing.length > 5 ? ' …' : ''}`)
      }
    }

    return results.filter(Boolean)
  }
}

/**
 * ProxyServer
 *
 * 只负责单节点的“状态 + 指标生命周期”。
 * 不发网络请求，不知道 Plugins API。
 */
class ProxyServer {
  constructor(config, options) {
    this.options = options
    this.group = config.group
    this.id = config.id
    this.priority = 1
    this.primaryPath = config.primaryPath || null
    this.fallbackPath = config.fallbackPath || null
    this.preferredProbePath = this.primaryPath
    this.identityKey = this.buildIdentityKey(config)
    this.attached = true
    this.metricVersion = 1
    this.probeSeq = 0

    // PATCH2-P0 Abort Chain：每个 kind 一个在途 controller，full / current 互不干扰
    this.activeProbeControllers = new Map()
    // PATCH2-P2：每个 kind 独立的探测序号（跨 kind 互不作废）
    this.kindSeq = new Map()

    this.ewmaLatency = null
    this.lastDelay = null
    this.lastTestUrl = ''
    this.lastProbePath = ''
    this.successSamples = 0
    this.fastFailureCount = 0
    this.failureCount = 0
    this.penalty = 0
    this.lastPenaltyUpdate = Date.now()
    this.state = 'CLOSED'
    this.nextAttempt = 0
    this.recent = []

    // PATCH2-P3 Metric Isolation：两个互不干扰的指标容器
    // 普通节点测速 → fullProbeMetric（EWMA / 稳定率 / 分数）
    this.fullProbeMetric = { lastOkAt: 0, lastFailAt: 0, okCount: 0, failCount: 0 }
    // 当前节点快速检测 → currentProbeMetric（不参与评分，只决定“要不要切走”）
    this.currentProbe = this.createCurrentProbeMetric()
  }

  buildIdentityKey(config) {
    return [config.group || '', config.id || '', config.primaryPath || '', config.fallbackPath || ''].join('\u0001')
  }

  /*
   * PATCH7-S1：本方法当前是「纯直通」，**刻意保留而非删除**。
   *
   * 依据（MEMORY 1.6 实测）：宿主 `/providers/proxies` 恒返回 `{}`、390 条节点里带 `provider`
   * 字段的 0 条 ⇒ `CoreAdapter.listNodes()` 里那条 provider healthcheck 分支**恒不可达**
   * ⇒ `fallbackPath` 恒为 null ⇒ `paths` 恒为 `[primaryPath]` ⇒ 「记住上次成功的路径」这套
   * 主备切换逻辑（preferredProbePath / rememberProbePath）目前永远不会走出单元素数组。
   *
   * 为什么不删：
   *   ① 这是宿主的返回值决定的，不是本插件的设计 —— 哪天 App 支持 provider 就立刻需要它；
   *   ② 删掉会把「主路径失败 → 退到 /proxies/{id}/delay」这条已实现的回退链一起拆掉；
   *   ③ 它的存在成本是一次数组比较，没有副作用。
   * ★ 判定口径：**冗余 ≠ 有 bug**。它现在等价于 `[primaryPath]`，行为正确，无需改动。
   */
  getProbePaths() {
    const paths = [this.primaryPath, this.fallbackPath].filter(Boolean)
    if (!this.preferredProbePath || !paths.includes(this.preferredProbePath)) return paths
    return [this.preferredProbePath, ...paths.filter((path) => path !== this.preferredProbePath)]
  }

  // PATCH7-S1：同 getProbePaths —— provider 可用后才会真正产生作用，保留。
  rememberProbePath(path) {
    if (!path) return
    if (path === this.primaryPath || path === this.fallbackPath) this.preferredProbePath = path
  }

  /**
   * 节点仍是同一个 id、探测端点没有变化：保留历史指标。
   * 端点发生变化：旧延迟基线不再可信，完整清理指标并进入新的 metricVersion。
   */
  rebind(config) {
    const nextIdentity = this.buildIdentityKey(config)
    if (nextIdentity === this.identityKey) {
      this.attached = true
      return false
    }

    // PATCH2-P0：身份变化 ⇒ 先取消在途探测，旧结果不再有意义
    this.abortProbe()

    this.group = config.group
    this.id = config.id
    this.primaryPath = config.primaryPath || null
    this.fallbackPath = config.fallbackPath || null
    this.preferredProbePath = this.primaryPath
    this.identityKey = nextIdentity
    this.attached = true
    this.resetMetrics('probe-endpoint-changed')
    return true
  }

  /**
   * PATCH2-P0：节点移除 / 停止 runtime 时调用。
   * 1) 取消所有在途探测；2) 作废全部 token（metricVersion / probeSeq / kindSeq）；
   * 3) 清空快速检测指标（避免旧节点的健康状态被新节点复用）。
   */
  detach() {
    this.abortProbe()
    this.attached = false
    this.metricVersion++
    this.probeSeq++
    this.kindSeq.clear()
    this.currentProbe = this.createCurrentProbeMetric()
    this.fastFailureCount = 0
  }

  resetMetrics(reason = 'reset') {
    this.metricVersion++
    this.probeSeq++
    this.kindSeq.clear()
    this.ewmaLatency = null
    this.lastDelay = null
    this.lastTestUrl = ''
    this.lastProbePath = ''
    this.successSamples = 0
    this.fastFailureCount = 0
    this.failureCount = 0
    this.penalty = 0
    this.lastPenaltyUpdate = Date.now()
    this.state = 'CLOSED'
    this.nextAttempt = 0
    this.recent = []
    this.lastMetricResetReason = reason
    this.currentProbe = this.createCurrentProbeMetric()
    this.fullProbeMetric = { lastOkAt: 0, lastFailAt: 0, okCount: 0, failCount: 0 }
  }

  createCurrentProbeMetric() {
    return {
      lastDelay: null,
      fastFailureCount: 0,
      windowStartedAt: 0,
      lastOkAt: 0,
      lastFailAt: 0,
      lastErrorMessage: '',
    }
  }

  // PATCH2-P0 Abort Chain
  createProbeController(key) {
    const controller = new AbortController()
    this.activeProbeControllers.set(key, controller)
    return controller
  }

  /**
   * PATCH4-M4：只删除「本次探测自己创建的」controller。
   * 旧版无条件 delete ⇒ 同 kind 的旧探测 finally 晚到时，会把新探测刚放进 Map 的 controller 删掉，
   * 新探测从此不在 Map 里、abortProbe 再也取消不了它（孤儿 fetch）。
   * 不传 controller 时保持旧的「按 key 删除」行为。
   */
  releaseProbeController(key, controller) {
    if (!key) return
    if (controller && this.activeProbeControllers.get(key) !== controller) return
    this.activeProbeControllers.delete(key)
  }

  /**
   * 真正的取消（旧版的 abortProbe 是假取消：token.signal 从未挂到 fetch 上）。
   * 带 key 只取消该 kind（full / current 互不影响）；不带 key 取消全部。
   */
  abortProbe(key) {
    if (key) {
      const controller = this.activeProbeControllers.get(key)
      if (controller) {
        this.activeProbeControllers.delete(key)
        try {
          controller.abort()
        } catch (e) {
          // AbortController.abort() 理论不会失败
        }
      }
      return
    }

    for (const controller of this.activeProbeControllers.values()) {
      try {
        controller.abort()
      } catch (e) {
        // AbortController.abort() 理论不会失败
      }
    }
    this.activeProbeControllers.clear()
  }

  // PATCH2-P2 Probe Token Generation
  /**
   * 生成探测 token，校验维度：
   *   kind / kindSeq（同 kind 最新）/ metricVersion / identityKey / runtimeGeneration / managerGeneration
   * 同 kind 的新探测会先取消旧的同 kind 探测（跨 kind 互不影响）。
   */
  beginProbe(meta) {
    const info = meta || {}
    const kind = info.kind || 'full'

    this.abortProbe(kind)

    const kindSeq = (this.kindSeq.get(kind) || 0) + 1
    this.kindSeq.set(kind, kindSeq)
    this.probeSeq += 1

    const controller = this.createProbeController(kind)
    const generation = Number.isFinite(info.generation) ? info.generation : 0

    return {
      // controller 在 Map 中的键；探测结束必须 release
      key: kind,
      kind,
      // PATCH4-M4：release 时用它证明「这个 controller 还是我的」
      controller,
      // 全局序号（可观测性）
      seq: this.probeSeq,
      // 同 kind 序号（校验用）
      kindSeq,
      // 运行代际：旧 runtime 的结果一律作废
      runtimeGeneration: generation,
      generation,
      // Manager 代际：同一 session 内 Reconfigure 也不继承
      managerGeneration: Number.isFinite(info.managerGeneration) ? info.managerGeneration : 0,
      metricVersion: this.metricVersion,
      identityKey: this.identityKey,
      testUrl: info.testUrl || '',
      // ★ 本次探测专属取消信号（由 ProbeCoordinator 与 runtime signal 合并后挂到 fetch）
      signal: controller.signal,
    }
  }

  /**
   * PATCH2-P2：强校验。
   * ★ runtimeGeneration / managerGeneration 必须显式传入且为有限数 —— 不给默认值，
   *   漏传即拒绝；旧版 `token?.generation && ...` 的写法在 generation 为 0 时会整条跳过校验。
   */
  isTokenValid(token, runtimeGeneration, managerGeneration) {
    if (!token) return false
    if (!this.attached) return false
    if (!Number.isFinite(runtimeGeneration)) return false
    if (!Number.isFinite(managerGeneration)) return false
    if (token.runtimeGeneration !== runtimeGeneration) return false
    if (token.managerGeneration !== managerGeneration) return false
    if (token.metricVersion !== this.metricVersion) return false
    if (token.identityKey !== this.identityKey) return false
    if (token.kindSeq !== (this.kindSeq.get(token.kind) || 0)) return false
    return true
  }

  // PATCH2-P2 Probe Token Generation
  /**
   * 只有 full probe 走这里：写入 EWMA / 稳定率 / 罚分 / 断路器。
   * ★PATCH2-P3：current probe 的结果一律不得进入本方法。
   */
  recordProbe(token, result, runtimeGeneration, managerGeneration) {
    if (!this.isTokenValid(token, runtimeGeneration, managerGeneration)) return false
    if (result?.cancelled) return false
    // PATCH4-M9：控制面失败不是节点的责任，不得写进 EWMA / penalty / failureCount
    if (result?.controlPlane) return false
    if (token.kind === 'current') return false

    const now = Date.now()
    this.lastTestUrl = token.testUrl
    this.lastProbePath = result?.path || ''

    if (result?.ok && Number.isFinite(result.delay) && result.delay > 0) {
      this.fullProbeMetric.okCount += 1
      this.fullProbeMetric.lastOkAt = now
      this.recordSuccess(result.delay)
    } else {
      this.fullProbeMetric.failCount += 1
      this.fullProbeMetric.lastFailAt = now
      this.recordFailure()
    }
    return true
  }

  get stability() {
    const ok = this.recent.filter(Boolean).length
    const n = this.recent.length
    return (ok + 1) / (n + 2)
  }

  decayedPenalty(now) {
    const dt = Math.max(0, (now - this.lastPenaltyUpdate) / 1000)
    return this.penalty * Math.exp(-this.options.penaltyDecayRate * dt)
  }

  recordSuccess(latency) {
    const now = Date.now()
    const alpha = this.options.ewmaAlpha
    this.ewmaLatency = this.ewmaLatency === null ? latency : alpha * latency + (1 - alpha) * this.ewmaLatency
    this.successSamples = Math.min(this.successSamples + 1, WARMUP_SUCCESS_SAMPLES)
    this.fastFailureCount = 0
    this.lastDelay = latency
    this.failureCount = 0
    this.state = 'CLOSED'
    this.nextAttempt = 0
    this.penalty = this.decayedPenalty(now)
    this.lastPenaltyUpdate = now
    this.pushRecent(true)
  }

  recordFailure() {
    const now = Date.now()
    this.failureCount = Math.min(this.failureCount + 1, this.options.failureThreshold)
    this.lastDelay = null
    this.penalty = Math.min(this.decayedPenalty(now) + this.options.penaltyIncrement, PENALTY_MAX)
    this.lastPenaltyUpdate = now
    this.pushRecent(false)

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN'
      this.nextAttempt = now + this.options.circuitBreakerTimeout
    }
  }

  // PATCH2-P3 Metric Isolation
  /**
   * 当前节点快速检测：成功。
   * ★ 只写独立容器 currentProbeMetric + lastDelay（UI / 实测基准），
   *   绝不写 ewmaLatency / penalty / recent / failureCount —— 评分系统零污染。
   */
  recordCurrentProbeSuccess(token, delay, result) {
    const metric = this.currentProbe
    const now = Date.now()

    metric.lastDelay = delay
    metric.fastFailureCount = 0
    metric.windowStartedAt = 0
    metric.lastOkAt = now
    metric.lastErrorMessage = ''

    this.fastFailureCount = 0
    this.lastTestUrl = token?.testUrl || this.lastTestUrl
    this.lastProbePath = result?.path || ''
    // lastDelay 只用于 UI 展示与「实测比较基准」，getScore() 不读它
    this.lastDelay = delay

    // 熔断态恢复属于 current 自己的生命周期（不算污染评分系统），
    // 且刻意不动 failureCount：HALF_OPEN 下一次失败仍应立刻回到 OPEN。
    if (this.state !== 'CLOSED' && now >= this.nextAttempt) {
      this.state = 'CLOSED'
      this.nextAttempt = 0
    }

    return true
  }

  /**
   * 当前节点快速检测：失败。
   * ★PATCH2-P4：失败必须在 currentFailureWindowMs 窗口内**连续**累积；
   *   窗口外的旧失败清零 ⇒ 单次网络抖动不会触发错误切换。
   * ★ 同样不写 failureCount / penalty / recent / 断路器。
   */
  recordCurrentProbeFailure(token, result, windowMs) {
    const metric = this.currentProbe
    const now = Date.now()
    const window = Math.max(1000, Number(windowMs) || CURRENT_FAILURE_WINDOW_DEFAULT)

    if (!metric.windowStartedAt || now - metric.windowStartedAt > window) {
      metric.windowStartedAt = now
      metric.fastFailureCount = 0
    }

    metric.fastFailureCount += 1
    metric.lastDelay = null
    metric.lastFailAt = now
    metric.lastErrorMessage = result?.error || ''

    this.fastFailureCount = metric.fastFailureCount
    this.lastDelay = null

    return metric.fastFailureCount
  }

  /**
   * 重置快速检测生命周期（重新绑定 current / 切换 / 节点身份变化时调用），
   * 避免上一段任期或上一轮 runtime 的失败计数被继承。
   */
  resetCurrentProbe() {
    this.currentProbe = this.createCurrentProbeMetric()
    this.fastFailureCount = 0
  }

  pushRecent(ok) {
    this.recent.push(ok)
    const cap = this.options.stabilityWindow
    if (this.recent.length > cap) this.recent.splice(0, this.recent.length - cap)
  }

  refreshCircuit() {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttempt) this.state = 'HALF_OPEN'
  }

  isAvailable() {
    if (this.state === 'CLOSED') return true
    if (this.state === 'OPEN') return Date.now() >= this.nextAttempt
    return true
  }

  getScore() {
    if (this.state !== 'CLOSED' || this.ewmaLatency === null) return -Infinity

    const now = Date.now()
    const priorityScore = this.options.priorityWeight * this.priority
    const latencyScore = this.options.latencyWeight * (1000 / this.ewmaLatency)
    const stabilityScore = this.options.stabilityWeight * this.stability
    const penaltyScore = this.options.penaltyWeight * this.decayedPenalty(now)
    return priorityScore + latencyScore + stabilityScore - penaltyScore
  }
}

/**
 * ProxyManager
 *
 * 每个策略组一个 Manager。
 * 负责：
 *   - 节点列表生命周期；
 *   - 检测轮调度；
 *   - 指标结果接收；
 *   - v1.6 原有选节点算法；
 *   - 切换协调。
 *
 * 不负责：
 *   - 具体 fetch；
 *   - 内核 API 结构适配。
 */
class ProxyManager {
  constructor(group, nodeConfigs, options, core, coordinator) {
    this.group = group
    this.options = Object.assign(
      {
        ewmaAlpha: 0.3,
        failureThreshold: 4,
        circuitBreakerTimeout: 120 * 1000,
        penaltyIncrement: 5,
        penaltyDecayRate: 0.002,
        priorityWeight: 1,
        latencyWeight: 100,
        penaltyWeight: 1,
        stabilityWeight: 50,
        stabilityWindow: STABILITY_WINDOW,
        hysteresisMargin: 20,
        monitorIntervalMs: RUNTIME_DEFAULTS.monitorIntervalMs,
        probeTimeoutMs: RUNTIME_DEFAULTS.probeTimeoutMs,
        currentCheckIntervalMs: CURRENT_CHECK_INTERVAL_DEFAULT,
        currentFailureThreshold: CURRENT_FAILURE_THRESHOLD_DEFAULT,
        switchCooldownMs: 300000,
        // PATCH3-P2：故障切换独立冷却（0 = 关闭限速，退回旧行为）
        failoverCooldownMs: FAILOVER_COOLDOWN_DEFAULT,
        // PATCH4-M7：宿主切换调用的超时上限
        switchCallTimeoutMs: SELECT_PROXY_TIMEOUT_MS,
        maxSwitchPerHour: 10,
        concurrency: RUNTIME_DEFAULTS.concurrency,
        testUrls: [],
      },
      options,
    )

    this.core = core
    this.coordinator = coordinator
    this.proxies = nodeConfigs.map((config) => new ProxyServer(config, this.options))

    this.lastSwitchTime = 0
    // PATCH3-P2：故障切换独立记时（与 lastSwitchTime 分开，两者互不覆盖）
    this.lastFailoverTime = 0
    this.switchHistory = []
    this.lastSwitchInfo = null
    this.lastRoundCostMs = 0

    this.running = false
    this.ticking = false
    this.currentTicking = false
    this.switching = false

    // PATCH2-P1 Switch Transaction
    // 正在执行的切换事务（阶段机 prepare → execute → verify → commit）
    this.activeSwitch = null
    // 被拒后排队等待的切换事务（故障类插队，不丢弃）
    this.pendingSwitch = null
    // 全局递增切换序号；activeSwitchSeq = 当前唯一有资格提交的序号
    this.switchSeq = 0
    this.activeSwitchSeq = 0

    // PATCH2-P4 Circuit Protection：快速检测的抖动窗口
    // 取「快速检测间隔 × 阈值 × 2」与下限 CURRENT_FAILURE_WINDOW_DEFAULT 的较大者
    this.currentFailureWindowMs = Math.max(CURRENT_FAILURE_WINDOW_DEFAULT, Number(this.options.currentCheckIntervalMs || 0) * Math.max(2, Number(this.options.currentFailureThreshold) || 2) * 2)

    this.timer = null
    this.currentTimer = null
    this.current = null
    /*
     * PATCH4-M8：内核当前选择落在插件管理范围之外（DIRECT / REJECT 等内置出站）时为真。
     * 此时 current 已被清空，但切换必须暂停 —— 否则 evaluateSwitch 的「首次接管」分支
     * 会把用户手动选的 DIRECT 直接改成插件认为最优的叶子节点。
     */
    this.externalSelection = false
    this.roundTestUrl = DEFAULT_TEST_URL
    this.session = null
    this.managerGeneration = 0
  }

  // PATCH2-P1 Switch Transaction
  /**
   * 切换事务资格：runtime 仍是同一个 session、事务代际一致、且本事务仍是当前唯一有效序号。
   * ★ 任何 await 之后都必须重新调用（旧事务晚回来时 seq 已过期 ⇒ 永远失去提交资格）。
   */
  isSwitchValid(tx, session) {
    return !!(tx && this.isSessionActive(session) && tx.generation === session.id && tx.managerGeneration === this.managerGeneration && tx.seq === this.activeSwitchSeq)
  }

  get randomTestUrl() {
    const urls = this.options.testUrls
    if (!Array.isArray(urls) || urls.length === 0) return DEFAULT_TEST_URL
    return urls[Math.floor(Math.random() * urls.length)]
  }

  isSessionActive(session) {
    return !!(this.running && this.session === session && session && !session.controller.signal.aborted && session.isActive())
  }

  startMonitoring(session) {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer)
      this.currentTimer = null
    }
    this.running = false
    this.ticking = false
    this.currentTicking = false
    this.switching = false
    // PATCH2-P1：新一代 runtime 不继承任何旧切换事务
    this.activeSwitch = null
    this.pendingSwitch = null
    this.switchSeq = 0
    this.activeSwitchSeq = 0
    this.current = null
    this.externalSelection = false
    this.session = session
    this.running = true
    this.managerGeneration += 1
    this.roundTestUrl = this.randomTestUrl
    // PATCH6-M1：暖机加速的计时基准。每次重建 Manager（Start / Reconfigure）都重新起算
    this.tickRounds = 0
    this.warmupFastUntil = Date.now() + WARMUP_FAST_WINDOW_MS
    this.warmupGraceLogged = false

    this.scheduleNext(0, session)
    this.scheduleCurrentNext(this.options.currentCheckIntervalMs, session)
  }

  /**
   * PATCH6-M1：暖机未完成的前几轮用短间隔连跑。
   *
   * 原版固定排 monitorIntervalMs ⇒ 实际周期 = 单轮耗时 + 间隔 ≈ 4~5 分钟，
   * 而 healthyPool() 要每个节点各 2 次成功样本 ⇒ 重启后有 8~10 分钟「无候选空窗」，
   * 期间首次接管 / 故障转移 / 延迟更优三条路径全部静默跳过。
   *
   * ★ 只改节奏、不改任何判定；两个闸门（轮数上限 / 时间上限）任一到即回常规节奏 ——
   *   否则「组里有一个永久不可用的节点」会让加速条件永不结束。
   */
  scheduleNext(delayMs, session) {
    if (!this.isSessionActive(session)) return

    this.timer = setTimeout(
      async () => {
        this.timer = null
        if (!this.isSessionActive(session)) return

        await this.tick(session)
        if (!this.isSessionActive(session)) return

        this.tickRounds = (this.tickRounds || 0) + 1
        const warmingUp = this.proxies.some((proxy) => proxy.successSamples < WARMUP_SUCCESS_SAMPLES)
        const withinGrace = this.tickRounds <= WARMUP_FAST_MAX_ROUNDS && Date.now() < (this.warmupFastUntil || 0)
        const nextDelay = warmingUp && withinGrace ? Math.min(WARMUP_FAST_INTERVAL_MS, this.options.monitorIntervalMs) : this.options.monitorIntervalMs

        if (warmingUp && !withinGrace && !this.warmupGraceLogged) {
          // 加速窗口用尽（轮数到 **或** 时间到）仍未凑齐样本 ⇒ 只留一次痕，避免每次要么不打要么刷屏
          this.warmupGraceLogged = true
          console.log(SPS_TAG, `【${this.group}】暖机加速窗口用尽（已 ${this.tickRounds} 轮），仍有节点未完成 ${WARMUP_SUCCESS_SAMPLES} 次成功采样，已回到常规检测节奏`)
        }

        this.scheduleNext(nextDelay, session)
      },
      Math.max(0, Number(delayMs) || 0),
    )
  }

  scheduleCurrentNext(delayMs, session) {
    if (!this.isSessionActive(session)) return

    this.currentTimer = setTimeout(
      async () => {
        this.currentTimer = null
        if (!this.isSessionActive(session)) return

        await this.tickCurrent(session)
        if (this.isSessionActive(session)) this.scheduleCurrentNext(this.options.currentCheckIntervalMs, session)
      },
      Math.max(0, Number(delayMs) || 0),
    )
  }

  // PATCH2-P1 Switch Transaction
  /**
   * 停止监控：★先作废所有在途切换的提交资格，再清定时器与节点。
   * 顺序不能反 —— 先停定时器的话，仍在 await handleUseProxy / waitForCurrent 的旧事务
   * 还有资格提交状态（Stop 后被回写就是这个原因）。
   */
  stopMonitoring() {
    this.running = false

    this.switching = false
    this.activeSwitch = null
    this.pendingSwitch = null
    this.switchSeq += 1
    this.activeSwitchSeq = this.switchSeq

    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.currentTimer !== null) {
      clearTimeout(this.currentTimer)
      this.currentTimer = null
    }

    if (this.proxies) this.proxies.forEach((proxy) => proxy.detach())
    this.current = null
    this.session = null
  }

  async tick(session) {
    /*
     * PATCH3-P1：解除与 tickCurrent 的跨类互斥。
     * 两类检测的工作集不重叠 —— checkAll 明确排除 current 节点、probe token 的 controller
     * 又按 kind（full / current）分键存放，因此并发不会互相污染。
     * 旧的双向互斥只会让「快检耗时期间整轮全池检测被静默跳过」，实际频率低于配置值。
     * 与在途切换的互斥（this.switching）保留：syncCurrentFromKernel 不得覆盖切换结果。
     */
    if (!this.isSessionActive(session) || this.ticking || this.switching) return

    this.ticking = true
    const startedAt = Date.now()

    try {
      const syncState = this.syncNodes(session)
      if (!this.isSessionActive(session)) return
      if (syncState === 'missing' || syncState === 'empty' || this.proxies.length === 0) return

      this.syncCurrentFromKernel()
      if (!this.isSessionActive(session)) return

      await this.checkAll(session)
      if (!this.isSessionActive(session)) return

      await this.evaluateSwitch(session)
    } catch (error) {
      if (!error?.cancelled && this.isSessionActive(session)) {
        console.warn(SPS_TAG, `【${this.group}】巡检异常：`, error?.message || error)
      }
    } finally {
      const cost = Date.now() - startedAt
      if (this.isSessionActive(session)) {
        this.lastRoundCostMs = cost
        if (cost > this.options.monitorIntervalMs) {
          console.warn(SPS_TAG, `【${this.group}】单轮耗时 ${Math.round(cost / 1000)}s，超过检测间隔 ` + `${Math.round(this.options.monitorIntervalMs / 1000)}s。`)
          notifyOnce('slow-round:' + this.group, () => Plugins.message.info(`策略组【${this.group}】单轮检测耗时已超过设定间隔，实际检测节奏会进一步变慢。`))
        }
        notifyDataChanged()
      }
      this.ticking = false
    }
  }

  syncNodes(session) {
    if (!this.isSessionActive(session)) return 'inactive'

    const fresh = this.core.listNodes(this.group)
    if (fresh === null) {
      if (this.proxies.length > 0 || this.current) {
        this.proxies.forEach((proxy) => proxy.detach())
        this.proxies = []
        this.current = null
        notifyDataChanged()
        console.log(SPS_TAG, `策略组【${this.group}】已不存在，清空插件节点状态`)
      }
      return 'missing'
    }

    if (fresh.length === 0) {
      if (this.proxies.length > 0 || this.current) {
        this.proxies.forEach((proxy) => proxy.detach())
        this.proxies = []
        this.current = null
        notifyDataChanged()
        console.log(SPS_TAG, `策略组【${this.group}】当前为空，清空插件节点状态`)
      }
      return 'empty'
    }

    const oldById = new Map(this.proxies.map((proxy) => [proxy.id, proxy]))
    const next = []
    let changed = false

    for (const config of fresh) {
      const old = oldById.get(config.id)
      if (old) {
        const identityChanged = old.rebind(config)
        if (identityChanged) {
          changed = true
          // PATCH2-P3：节点身份 / 探测端点变化后 current 指针必须重新确认，
          // 否则新身份会继承旧身份的健康状态（旧快速检测计数、旧 lastDelay）。
          if (this.current === old) {
            old.resetCurrentProbe()
            this.current = null
            console.log(SPS_TAG, `当前节点探测身份变化，已清空 current 指针待重新确认：${old.id}`)
          }
        }
        next.push(old)
      } else {
        next.push(new ProxyServer(config, this.options))
        changed = true
      }
    }

    const keep = new Set(next)
    for (const proxy of this.proxies) {
      if (!keep.has(proxy)) proxy.detach()
    }

    if (next.length !== this.proxies.length) changed = true
    if (fresh.some((config, index) => config.id !== this.proxies[index]?.id)) changed = true

    this.proxies = next

    if (this.current && !this.proxies.includes(this.current)) this.current = null

    if (changed) {
      console.log(SPS_TAG, `策略组【${this.group}】节点列表已同步，当前 ${this.proxies.length} 个节点`)
      notifyDataChanged()
    }

    return 'ok'
  }

  async checkAll(session) {
    if (!this.isSessionActive(session)) throw createCancelledError()

    for (const proxy of this.proxies) proxy.refreshCircuit()

    this.syncCurrentFromKernel()
    const currentId = this.current?.id
    const targets = this.proxies.filter((proxy) => proxy.id !== currentId && proxy.isAvailable())
    if (targets.length === 0) return

    const results = await this.coordinator.probeMany(targets, this.roundTestUrl, this.options.probeTimeoutMs, this.options.concurrency, session.controller.signal, session.id, this.managerGeneration, this.options.debugProbeLog)

    if (!this.isSessionActive(session)) throw createCancelledError()

    for (const item of results) {
      if (!this.isSessionActive(session)) throw createCancelledError()
      if (this.proxies.includes(item.proxy)) {
        // ★PATCH2-P2：旧 runtime 的结果直接丢弃（不强依赖 recordProbe 内部校验）
        if (item.token.runtimeGeneration !== session.id) continue
        if (item.result?.ok) item.proxy.rememberProbePath(item.result.path)
        // 校验参必须显式传齐：漏传 = 拒绝，不再有“静默通过”的分支
        item.proxy.recordProbe(item.token, item.result, session.id, this.managerGeneration)
      }
    }
  }

  async tickCurrent(session) {
    /*
     * ★ 入口不再因为 this.switching 而整轮跳过。
     * 旧版 tickCurrent 的 `|| this.switching` 正是“故障切换被正常切换挡掉、直接丢失”的根因：
     * 切换期间这一轮根本不跑，等于故障检测被关掉。
     * 现在改为：照常检测；需要切换时若已有在途事务，由 switchTo 排队而不是丢弃。
     */
    // PATCH3-P1：不再因为全池检测（tick）在跑就整轮跳过 —— 切换期间恰恰是最需要快检的时候
    if (!this.isSessionActive(session) || this.currentTicking) return

    this.currentTicking = true
    let probeProxy = null
    let token = null

    try {
      this.syncNodes(session)
      if (!this.isSessionActive(session)) throw createCancelledError()

      this.syncCurrentFromKernel()
      const current = this.current
      if (!current) return

      current.refreshCircuit()
      if (current.state === 'OPEN') return

      // PATCH2-P2 Probe Token Generation：token 绑定 runtime / manager 代际与 metricVersion
      token = current.beginProbe({
        kind: 'current',
        testUrl: this.roundTestUrl,
        generation: session.id,
        managerGeneration: this.managerGeneration,
      })
      probeProxy = current

      // PATCH4-M1：同上，逐条日志改为开关控制（默认关）
      const debugProbeLog = !!this.options.debugProbeLog
      const probeStartedAt = debugProbeLog ? Date.now() : 0
      if (debugProbeLog) console.log(SPS_TAG, `Probe开始：组=${current.group}，节点=${current.id}，类型=current，generation=${session.id}`)

      const result = await this.coordinator.probe(current, this.roundTestUrl, this.options.probeTimeoutMs, session.controller.signal, token)

      if (debugProbeLog) {
        const probeCostMs = Date.now() - probeStartedAt
        const probeState = result?.cancelled ? '取消' : result?.ok ? `成功 ${Math.round(result.delay)}ms` : `失败${result?.error ? `：${result.error}` : ''}`
        console.log(SPS_TAG, `Probe完成：组=${current.group}，节点=${current.id}，${probeState}，耗时=${probeCostMs}ms，generation=${session.id}`)
      }

      if (!this.isSessionActive(session)) throw createCancelledError()
      if (!this.proxies.includes(current)) return

      // PATCH2-P0：取消 / 过期 token 的结果一律不得进入指标系统
      if (result.cancelled) return
      if (result.controlPlane) {
        // PATCH4-M9：控制面（内核 API）不可用 —— 不计节点账，但要留痕，否则用户不知道为何不切换
        notifyOnce('control-plane:' + this.group, () => Plugins.message.error(`策略组【${this.group}】无法访问内核 API（${result.error || '连接失败'}），本次不计入节点失败统计。请检查内核运行状态与 clash_api 凭据。`))
        return
      }
      if (!current.isTokenValid(token, session.id, this.managerGeneration)) {
        console.log(SPS_TAG, `快速检测结果丢弃：组=${this.group}，节点=${current.id}（token 已过期：旧 runtime / 旧 manager 代际 / 节点重绑 / 新探测已开始）`)
        return
      }

      if (result.ok) {
        current.rememberProbePath(result.path)
        // PATCH2-P3：只写 currentProbeMetric + lastDelay，不写 EWMA / penalty / recent / failureCount
        current.recordCurrentProbeSuccess(token, result.delay, result)
      } else {
        // PATCH2-P4：失败必须在抖动窗口内连续累积，单次网络抖动不触发切换
        const consecutive = current.recordCurrentProbeFailure(token, result, this.currentFailureWindowMs)

        if (consecutive >= this.options.currentFailureThreshold) {
          /*
           * PATCH2-P4：先置 OPEN 再调 failoverFromCurrent —— 顺序不能反。
           * 后者开头 `if (!current || current.state === 'CLOSED') return false`（L1656 附近）
           * 会把 CLOSED 节点直接拒掉（MEMORY 2.33「看守卫要看调用点」的形态）。
           */
          current.state = 'OPEN'
          current.nextAttempt = Date.now() + this.options.circuitBreakerTimeout
          const switched = await this.failoverFromCurrent(session, `当前节点快速检测 ${Math.round(this.currentFailureWindowMs / 1000)}s 内连续失败 ${consecutive} 次`)

          /*
           * PATCH6-W1：没切走就别把监控也一起关掉。
           * 切换可能因池空 / 额度用尽 / 故障冷却 / 宿主调用失败而不成立，
           * 此时若让节点留在 OPEN，会同时触发两件事：
           *   ① tickCurrent 入口 `if (current.state === 'OPEN') return` ⇒ 后续每 30s 全部空转，
           *      既不继续采集失败证据，也发现不了节点已经恢复；
           *   ② 该节点被 healthyPool() 排除 ⇒ 它也不会被全池巡检重新评优。
           * ⇒ 最长 circuitBreakerTimeout（默认 120s）的完全静止。
           * 置 HALF_OPEN：下一拍快检照常跑（HALF_OPEN 不被入口守卫拦），成功即回 CLOSED，
           * 失败仍会因「现在距离 nextAttempt 还很远」由 recordCurrentProbeFailure 继续累积 —— 语义不变。
           */
          if (!switched) {
            current.state = 'HALF_OPEN'
            current.nextAttempt = Date.now() + Math.max(1000, this.options.currentCheckIntervalMs)
          }
        }
      }

      if (this.isSessionActive(session)) notifyDataChanged()
    } catch (error) {
      if (!error?.cancelled && this.isSessionActive(session)) {
        console.warn(SPS_TAG, `【${this.group}】当前节点快速检测异常：`, error?.message || error)
      }
    } finally {
      // PATCH2-P0：探测结束必须释放 controller，否则长期运行会累积（10 节点 × 每 30s 一次 ≈ 每天 4800 个）
      if (probeProxy && token) probeProxy.releaseProbeController(token.key, token.controller)
      this.currentTicking = false
    }
  }

  // PATCH2-P4 Circuit Protection
  /**
   * runtime 启动 / 重启 / 内核侧手工切换后，按内核实际 current 恢复插件侧指针。
   * ★ 不继承上一轮 runtime 的快速检测失败计数：否则新 runtime 一上来就可能被旧计数误触发切换。
   */
  syncCurrentFromKernel() {
    const liveId = this.core.getCurrentId(this.group)
    if (liveId === undefined) return false

    if (liveId === null) {
      let changed = false
      if (this.current) {
        this.current.resetCurrentProbe()
        this.current = null
        changed = true
      }
      if (this.externalSelection) {
        this.externalSelection = false
        changed = true
      }
      if (changed) notifyDataChanged()
      return true
    }

    const live = this.proxies.find((proxy) => proxy.id === liveId) || null
    if (live) {
      let changed = false
      if (!this.current || live.id !== this.current.id) {
        if (this.current) this.current.resetCurrentProbe()
        this.current = live
        live.resetCurrentProbe()
        changed = true
      }
      if (this.externalSelection) {
        this.externalSelection = false
        changed = true
      }
      if (changed) notifyDataChanged()
      return true
    }

    /*
     * PATCH4-M8：liveId 是字符串但不在插件节点池里，只有两种可能 ——
     *   ① 嵌套策略组（组里套组）：被 listNodes 的 `!Array.isArray(node.all)` 过滤掉了；
     *   ② 内置出站（DIRECT / REJECT / PASS…）：被 BUILTIN_NAME_RE 过滤掉了。
     * 旧版在这里直接 return false、保留旧 current ⇒ 快检每 30s 去打一个「没在用」的节点，
     * 真在承载流量的出站反而无人监控；旧节点若熔断还会以它为基准触发误切。
     *
     * B 方案（用户决策 2026-09-27）：两种情形都要清 current（让指针回归真实），
     * 但只有嵌套组允许接管：
     *   ① 嵌套组 —— 用户的意图本身就是「自动选择」⇒ 清空后 evaluateSwitch 走「首次接管」，
     *      由插件在组内挑最优叶子；
     *   ② 内置出站 —— 用户明确的手动选择 ⇒ 只清 current 并置 externalSelection，
     *      暂停切换，绝不覆盖。
     */
    const nestedGroup = Array.isArray(this.core.getGroup(liveId)?.all)
    const nextExternal = !nestedGroup
    const changed = !!this.current || this.externalSelection !== nextExternal

    if (this.current) {
      this.current.resetCurrentProbe()
      this.current = null
    }
    this.externalSelection = nextExternal

    if (changed) notifyDataChanged()
    return true
  }

  healthyPool() {
    return this.proxies.filter((proxy) => proxy.attached && proxy.state === 'CLOSED' && proxy.ewmaLatency !== null && proxy.successSamples >= WARMUP_SUCCESS_SAMPLES)
  }

  pickBestIn(pool) {
    let best = null
    let bestScore = -Infinity

    for (const proxy of pool) {
      const score = proxy.getScore()
      if (score > bestScore) {
        bestScore = score
        best = proxy
      }
    }
    return best
  }

  canSwitch() {
    const now = Date.now()
    this.switchHistory = this.switchHistory.filter((time) => now - time < 3600000)
    return this.switchHistory.length < this.options.maxSwitchPerHour
  }

  /**
   * PATCH4-M7：带超时的 Promise 包装。只用来兜住「宿主 API 挂死」；
   * 真正的取消仍由 session AbortSignal 负责（宿主 API 不可取消是它的固有属性）。
   */
  callWithTimeout(promise, ms) {
    let timer = null
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('SWITCH_CALL_TIMEOUT')
        error.switchTimeout = true
        reject(error)
      }, ms)
    })

    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== null) clearTimeout(timer)
    })
  }

  async waitForCurrent(proxy, session, tries = 12, gapMs = 200) {
    for (let i = 0; i < tries; i++) {
      if (!this.isSessionActive(session)) throw createCancelledError()
      const liveId = this.core.getCurrentId(this.group)
      if (liveId === proxy.id) return true
      await sleepWithSignal(gapMs, session.controller.signal)
    }
    return false
  }

  async failoverFromCurrent(session, reason) {
    if (!this.isSessionActive(session)) throw createCancelledError()

    const current = this.current
    if (!current || current.state === 'CLOSED') return false

    const pool = this.healthyPool().filter((proxy) => proxy.id !== current.id)
    if (!pool.length) {
      notifyOnce('all-down:' + this.group, () => Plugins.message.info(`策略组【${this.group}】当前没有可用节点（全部熔断或尚未完成暖机），已暂时停止切换`))
      return false
    }

    // PATCH3-P2：故障切换走独立冷却，既不共用「延迟更优」的 switchCooldownMs，
    // 也不再像旧版那样完全不限速。
    const now = Date.now()
    const cooldown = this.options.failoverCooldownMs
    if (cooldown > 0 && now - this.lastFailoverTime < cooldown) {
      const left = Math.ceil((cooldown - (now - this.lastFailoverTime)) / 1000)
      console.log(SPS_TAG, `【${this.group}】故障切换冷却中（剩余 ${left}s），本次跳过：${reason}`)
      return false
    }

    if (!this.canSwitch()) {
      // PATCH3-P2：额度用尽是「静默罢工」的源头，必须留痕（通知只发一次，日志每次都要有）
      console.warn(SPS_TAG, `【${this.group}】每小时切换额度已用尽（${this.switchHistory.length}/${this.options.maxSwitchPerHour}），故障切换被跳过：${reason}`)
      return false
    }

    const best = this.pickBestIn(pool)
    if (!best) return false
    return await this.switchTo(best, reason, session)
  }

  async evaluateSwitch(session) {
    if (!this.isSessionActive(session)) throw createCancelledError()

    this.syncCurrentFromKernel()

    // PATCH4-M8：内核当前选择在插件管理范围之外（内置出站）⇒ 不接管、不切换
    if (this.externalSelection) return

    const pool = this.healthyPool()

    if (!this.current) {
      const best = this.pickBestIn(pool)
      if (best) await this.switchTo(best, '首次接管', session)
      return
    }

    if (this.current.state !== 'CLOSED') {
      await this.failoverFromCurrent(session, '当前节点已熔断')
      return
    }

    /*
     * ★ v1.6 原算法保留：
     * 先按“确实快多少毫秒”筛候选，再在候选中按综合分选最优。
     *
     * PATCH2-P3 Metric Isolation 的配套改动：
     * 当前节点不再参与全池测速（其 EWMA 从当选那一刻起就被冻结），
     * 所以比较基准必须改用快速检测拿到的实测值 lastDelay，
     * 否则“延迟更优”永远算不出优势 ⇒ 永不切换。
     */
    const margin = this.options.hysteresisMargin
    const observed = Number.isFinite(this.current.lastDelay) ? this.current.lastDelay : this.current.ewmaLatency
    if (!Number.isFinite(observed)) return

    const faster = pool.filter((proxy) => proxy.id !== this.current.id && observed - proxy.ewmaLatency >= margin)
    const best = this.pickBestIn(faster)

    if (!best || best.id === this.current.id) return

    /*
     * PATCH6-W3：这两条早退原本完全静默。
     * 对照 failoverFromCurrent（冷却有 console.log、额度用尽有 console.warn）——
     * 同一道题，「性能更好」这条路径没补，于是用户看到「明明有个快 80ms 的节点它就不切」
     * 而控制台一行线索都没有（静默 = 无法归因，本项目最贵的一类缺陷）。
     * ★ 判定式与旧版严格等价：cooldownLeft > 0 ⇔ now - lastSwitchTime < switchCooldownMs；
     *   canSwitch() 仍在冷却通过后才调用（它会顺带清理 switchHistory，顺序不能提前）。
     */
    const gainMs = Math.round(observed - best.ewmaLatency)
    const cooldownLeft = this.options.switchCooldownMs - (Date.now() - this.lastSwitchTime)
    if (cooldownLeft > 0) {
      console.log(SPS_TAG, `【${this.group}】跳过「延迟更优」切换（普通冷却剩余 ${Math.ceil(cooldownLeft / 1000)}s）：目标=${best.id}，快 ${gainMs}ms`)
      return
    }
    if (!this.canSwitch()) {
      console.warn(SPS_TAG, `【${this.group}】每小时切换额度已用尽（${this.switchHistory.length}/${this.options.maxSwitchPerHour}），「延迟更优」切换被跳过：目标=${best.id}，快 ${gainMs}ms`)
      return
    }

    await this.switchTo(best, `快 ${gainMs}ms`, session)
  }

  // PATCH2-P1 Switch Transaction
  /**
   * 切换事务：prepare → execute → verify → commit。
   *
   * 隔离保证：
   *   1. 每个事务持独立 seq；新事务把旧事务的提交资格作废（activeSwitchSeq）。
   *   2. 每个 await 之后重新校验 runtime generation / session / 节点身份。
   *   3. commit 前回读内核 current，不一致就不写任何状态。
   *   4. 已被占用时**不丢弃**切换请求 —— 进 pendingSwitch 排队，当前事务结束后执行。
   *   5. 所有早退路径都保证队列残留被清理（赋值点在 try 语义之外也不会漏）。
   */
  async switchTo(proxy, reason, session) {
    if (!proxy || !this.isSessionActive(session)) return false

    // 目标已经是当前节点：不排队、不留残留
    if (this.current && this.current.id === proxy.id) return false

    const from = this.current?.id || '无'
    // PATCH3-P2：故障类切换（熔断 / 快检连败 / 不可用）走独立冷却。
    // 只算一次，排队优先级与提交记时共用同一判据，避免两处判据漂移。
    const isFailover = FAILOVER_REASON_RE.test(String(reason || ''))

    this.switchSeq += 1
    const tx = {
      id: `${this.managerGeneration}-${this.switchSeq}`,
      seq: this.switchSeq,
      from,
      target: proxy.id,
      generation: session.id,
      managerGeneration: this.managerGeneration,
      createdAt: Date.now(),
      phase: 'prepare',
      reason,
      // PATCH3-P2：在途事务也要能自证是否故障类（旧版只有排队分支才带这个字段）
      isFailover,
    }

    // 已有在途事务：排队（同目标去重、故障类插队、非故障不覆盖已排队的故障）
    if (this.switching) {
      const queued = this.pendingSwitch
      const shouldReplace = !queued || isFailover || queued.target === tx.target || !queued.isFailover
      if (shouldReplace) this.pendingSwitch = { ...tx, phase: 'queued', isFailover }
      return false
    }

    this.activeSwitchSeq = tx.seq
    this.activeSwitch = tx
    this.switching = true

    try {
      // ---------------- prepare ----------------
      if (!this.isSwitchValid(tx, session)) return false
      if (!this.proxies.includes(proxy) || !proxy.attached) return false
      if (!this.core.isRunning()) return false
      if (!this.core.isSelector(this.group)) return false

      // ---------------- execute ----------------
      tx.phase = 'execute'
      try {
        const callTimeoutMs = Math.round(Number(this.options.switchCallTimeoutMs) || SELECT_PROXY_TIMEOUT_MS)
        await this.callWithTimeout(this.core.selectProxy(this.group, proxy.id), callTimeoutMs)
      } catch (error) {
        if (!this.isSwitchValid(tx, session)) return false

        if (error?.switchTimeout) {
          // PATCH4-M7：超时 ⇒ 本事务作废。必须同时丢弃排队目标，
          // 否则锁一释放，排队的切换会立刻再撞同一个挂死调用。
          const ms = Math.round(Number(this.options.switchCallTimeoutMs) || SELECT_PROXY_TIMEOUT_MS)
          console.warn(SPS_TAG, `【${this.group}】调用宿主切换超过 ${ms}ms 未返回，已放弃本次事务：${from} → ${proxy.id}`)
          notifyOnce('switch-timeout:' + this.group, () => Plugins.message.info(`策略组【${this.group}】调用宿主切换超过 ${ms}ms 未返回，已放弃本次事务（后续检测照常进行）。`))
          this.pendingSwitch = null
          return false
        }

        const detail = error?.message || String(error)
        console.warn(SPS_TAG, `【${this.group}】调用宿主切换失败：`, detail)
        notifyOnce('switch-call-fail:' + this.group + ':' + proxy.id, () => Plugins.message.info(`策略组【${this.group}】调用宿主切换失败（${from} → ${proxy.id}）：${detail}`))
        return false
      }

      /*
       * handleUseProxy 本身若不能取消：停止 / 重配置只能让事务的“后半段”失去资格。
       * waitForCurrent 可被 session AbortSignal 立即打断。
       */
      const landed = await this.safeWaitForCurrent(proxy, session)
      if (!this.isSwitchValid(tx, session)) return false
      if (!landed) {
        notifyOnce('switch-fail:' + this.group + ':' + proxy.id, () => Plugins.message.info(`策略组【${this.group}】切换未生效（${from} → ${proxy.id}）`))
        return false
      }

      // ---------------- verify ----------------
      tx.phase = 'verify'
      if (!this.isSwitchValid(tx, session)) return false
      if (!this.proxies.includes(proxy) || !proxy.attached) return false

      const liveId = this.core.getCurrentId(this.group)
      if (liveId !== proxy.id) return false

      // ---------------- commit ----------------
      tx.phase = 'commit'
      const switchedAt = Date.now()
      this.current = proxy
      // PATCH2-P3 / PATCH2-P4：新节点接任，快速检测的失败计数不得继承旧节点
      proxy.resetCurrentProbe()
      this.lastSwitchTime = switchedAt
      // PATCH3-P2：只有故障类切换才刷新独立冷却时钟
      if (isFailover) this.lastFailoverTime = switchedAt
      this.switchHistory.push(switchedAt)
      this.lastSwitchInfo = {
        from,
        to: proxy.id,
        reason,
        at: switchedAt,
        transactionId: tx.id,
        runtimeGeneration: session.id,
      }

      console.log(SPS_TAG, `策略组【${this.group}】${from} → ${proxy.id}（${reason}）`)
      notifyDataChanged()
      return true
    } finally {
      /*
       * 只有“自己仍是当前唯一有效事务”时才释放锁并消费队列。
       * 旧事务晚回来时既不释放锁（新事务正持有），也不消费队列。
       */
      if (this.activeSwitchSeq === tx.seq) {
        this.switching = false
        this.activeSwitch = null
        this.drainPendingSwitch(session)
      }
    }
  }

  /**
   * waitForCurrent 在 session 失效时是 throw 而不是 return false。
   * 这里收敛成 false，让在途切换走“资格失效”的干净路径，而不是异常冒泡到 tick 的 catch。
   */
  async safeWaitForCurrent(proxy, session) {
    try {
      return await this.waitForCurrent(proxy, session)
    } catch (error) {
      if (error?.cancelled) return false
      throw error
    }
  }

  /**
   * PATCH2-P1：消费排队的切换事务。
   * ★ 必须在 finally、switching 已复位之后调用，并二次校验 session / generation / 目标。
   */
  drainPendingSwitch(session) {
    const next = this.pendingSwitch
    if (!next) return

    this.pendingSwitch = null

    if (!this.isSessionActive(session)) return
    if (next.generation !== session.id) return
    if (next.managerGeneration !== this.managerGeneration) return
    if (this.current && this.current.id === next.target) return

    const target = this.proxies.find((item) => item.id === next.target)
    if (!target || !target.attached) return
    // PATCH5-6：排队期间目标可能已熔断/劣化 ⇒ 消费前重评一次，不合格就放弃（留痕，不静默）
    if (!target.isAvailable()) {
      console.warn(SPS_TAG, '排队的切换目标已不可用，放弃本次排队切换：', next.target)
      return
    }

    queueMicrotask(() => {
      if (!this.isSessionActive(session)) return
      this.switchTo(target, next.reason, session).catch((error) => {
        console.warn(SPS_TAG, '排队的切换事务执行失败：', error?.message || error)
      })
    })
  }
}

/** @type {EsmPlugin} */
export default (Plugin) => {
  const { ref, shallowRef } = Vue
  const managers = shallowRef([])
  const isRunning = ref(false)
  const dataVersion = ref(0)

  const core = new CoreAdapter()
  const coordinator = new ProbeCoordinator(core)

  let runtimeGeneration = 0
  let activeRuntime = null
  // PATCH2-P1：最近一次生效的配置。无参 start 不再回退到「插件加载时的配置快照」
  let lastConfig = null

  const createRuntimeSession = () => {
    const id = ++runtimeGeneration
    const controller = new AbortController()
    const session = {
      id,
      controller,
      isActive: () => activeRuntime === session && !controller.signal.aborted && runtimeGeneration === id,
    }
    activeRuntime = session
    return session
  }

  const stopRuntime = () => {
    // PATCH11#1：手动停止 / 内核停止 / 插件卸载 / 重新配置 时，必须同时取消「自动接管」轮询定时器。
    // 旧版只有 onCoreStopped/onDispose 清了定时器，Stop（手动停止）漏了 ⇒ 定时器会在 60s 窗口内把已停的运行时重新拉起。
    cancelAutoStart()
    const previous = activeRuntime
    activeRuntime = null
    runtimeGeneration += 1

    if (previous) {
      try {
        previous.controller.abort()
      } catch (e) {
        // AbortController.abort() 理论上不会抛出；这里保持 dispose 幂等。
      }
    }

    for (const manager of managers.value) {
      try {
        manager.stopMonitoring()
      } catch (e) {
        console.warn(SPS_TAG, '停止 Manager 失败：', e?.message || e)
      }
    }

    managers.value = []
    isRunning.value = false
    notifyDataChanged()
    setPluginStatus(STATUS_STOPPED)
    return STATUS_STOPPED
  }

  const build = (config, kernelApi) => {
    const presetName = String(config.Preset || 'Stable')
    if (!PRESET_KEY[presetName]) {
      throw new Error('预设使用场景不存在，请检查插件配置（当前值：' + presetName + '）')
    }
    if (!kernelApi?.running) throw new Error('核心未运行，无法启动监测')

    // PATCH5-2：填了非列表类型时给出准确原因（旧版一律报「是空的」）
    if (config.IncludeGroup !== undefined && config.IncludeGroup !== null && !isListLike(config.IncludeGroup)) {
      throw new Error('「应用智能切换的策略组」格式不对：收到 ' + typeof config.IncludeGroup + '，请用列表控件填写')
    }
    const rawRequested = toStringList(config.IncludeGroup)
      .map((value) => String(value).trim())
      .filter(Boolean)
    /*
     * PATCH4-M2：同名策略组必须去重。
     * 写两个同名组会创建两个 ProxyManager 管同一个组 ⇒ 双倍探测、UI 双 Tab、
     * 两个 Manager 各自计一份切换额度（MaxSwitchPerHour=10 实际变 20），并且互相打架。
     * 去重留痕而不是静默处理：静默会让人以为「配置生效了」。
     */
    const requested = [...new Set(rawRequested)]
    if (requested.length !== rawRequested.length) {
      console.warn(SPS_TAG, '「应用智能切换的策略组」存在重复项，已去重：', rawRequested.join(' / '))
    }
    if (requested.length === 0) {
      throw new Error('「应用智能切换的策略组」是空的，请先填写要接管的策略组名称')
    }

    const preset = readPreset(config, presetName)
    const options = Object.assign({}, preset, {
      monitorIntervalMs: clampNum(config.MonitoringInterval, {
        def: RUNTIME_DEFAULTS.monitorIntervalMs,
        min: 5000,
        max: 3600000,
      }),
      probeTimeoutMs: clampNum(config.RequestTimeout, {
        def: RUNTIME_DEFAULTS.probeTimeoutMs,
        min: 1000,
        max: 60000,
      }),
      currentCheckIntervalMs: clampNum(config.CurrentCheckInterval, {
        def: CURRENT_CHECK_INTERVAL_DEFAULT,
        min: 10000,
        max: 600000,
      }),
      currentFailureThreshold: clampNum(config.CurrentFailureThreshold, {
        def: CURRENT_FAILURE_THRESHOLD_DEFAULT,
        min: 1,
        max: 5,
        int: true,
      }),
      switchCooldownMs: clampNum(config.SwitchCooldown, {
        def: 300000,
        min: 0,
        max: 3600000,
      }),
      // PATCH3-P2：故障切换独立冷却。配置键缺省时用内置默认；
      // 需要调整时在插件配置里加 FailoverCooldown（毫秒，0 = 关闭限速）。
      failoverCooldownMs: clampNum(config.FailoverCooldown, {
        def: FAILOVER_COOLDOWN_DEFAULT,
        min: 0,
        max: 3600000,
      }),
      maxSwitchPerHour: clampNum(config.MaxSwitchPerHour, {
        def: 10,
        min: 1,
        max: 200,
        int: true,
      }),
      concurrency: clampNum(config.ConcurrencyLimit, {
        def: RUNTIME_DEFAULTS.concurrency,
        min: 1,
        max: 50,
        int: true,
      }),
      // PATCH5-2：兼容字符串写法；全部非法时留痕（旧版静默退回默认地址）
      testUrls: (() => {
        const rawUrls = toStringList(config.TestUrlList).filter((url) => typeof url === 'string' && url.trim())
        const validUrls = rawUrls.filter((url) => /^https?:\/\//i.test(url.trim()))
        if (rawUrls.length > 0 && validUrls.length === 0) {
          console.warn(SPS_TAG, '「检测链接」里没有合法的 http(s) 地址，已退回默认地址：', rawUrls.join(' / '))
        }
        return validUrls
      })(),
      stabilityWindow: STABILITY_WINDOW,
      // PATCH4-M1：每次启动重新读取 ⇒ 改完 localStorage 重启插件即生效
      debugProbeLog: isDebugProbeLog(),
    })

    const groups = []
    const missing = []

    for (const name of requested) {
      // PATCH4-M6：非 Selector 组（URLTest / Fallback / LoadBalance）不可手动切换。
      // 接了它每轮都会：白测一轮 + 切换必然失败 + 白等 waitForCurrent 2.4s + 烧一次切换额度。
      if (!core.isSelector(name)) {
        missing.push(name + '(不是 Selector 组，无法手动切换)')
        continue
      }
      const nodes = core.listNodes(name)
      if (nodes === null) {
        missing.push(name)
        continue
      }
      if (nodes.length === 0) {
        missing.push(name + '(组内没有可测速节点)')
        continue
      }
      groups.push({ name, nodes })
    }

    if (groups.length === 0) {
      throw new Error('未匹配到任何可接管的策略组，请检查「应用智能切换的策略组」里的名称与配置完全一致')
    }

    return { presetName, options, groups, missing }
  }

  const apply = (built) => {
    /*
     * 先完成新配置 build，再终止旧 runtime。
     * 这样配置错误时，旧 runtime 不会被误杀。
     */
    stopRuntime()

    const session = createRuntimeSession()
    const nextManagers = built.groups.map(({ name, nodes }) => new ProxyManager(name, nodes, built.options, core, coordinator))

    managers.value = nextManagers
    isRunning.value = true

    for (const manager of nextManagers) manager.startMonitoring(session)
    notifyDataChanged()
    setPluginStatus(STATUS_RUNNING)
    return STATUS_RUNNING
  }

  const start = (config, force = false) => {
    if (!force && isRunning.value && activeRuntime?.isActive()) {
      setPluginStatus(STATUS_RUNNING)
      return STATUS_RUNNING
    }

    const cfg = config || lastConfig || Plugin
    const kernelApi = core.getStore()
    const built = build(cfg, kernelApi)
    /*
     * PATCH4-M5：只有配置真正通过校验（build 未抛错）才记住它。
     * 旧版在 build 之前赋值 ⇒ 非法配置会污染 lastConfig；而 lastConfig 只被「无参启动」取用，
     * 那个调用点是 onCoreStarted ⇒ 表现为「内核重启后插件静默不自启」
     *（手动点启动会因 isRunning 守卫提前 return，当场看不出问题）。
     */
    lastConfig = cfg

    const status = apply(built)

    console.log(SPS_TAG, `启动监测：预设=${built.presetName}，组=${built.groups.map((group) => group.name + '(' + group.nodes.length + ')').join(' / ')}，` + `并发=${built.options.concurrency}，间隔=${built.options.monitorIntervalMs}ms，超时=${built.options.probeTimeoutMs}ms，` + `切换阈值=${built.options.hysteresisMargin}ms，generation=${activeRuntime?.id || 0}`)

    if (built.missing.length) {
      console.warn(SPS_TAG, '以下策略组未接管：', built.missing.join(' / '))
      notifyOnce('missing-group:' + built.missing.join('|'), () => Plugins.message.info('以下策略组未接管（不存在 / 组内无可用节点 / 不是 Selector 组）：' + built.missing.join(' / ')))
    }

    return status
  }

  const failStatus = () => {
    const s = isRunning.value ? STATUS_RUNNING : STATUS_ERROR
    setPluginStatus(s)
    return s
  }

  let uiOpen = false
  let autoStartTimer = null

  // PATCH11#1：取消「自动接管」轮询定时器。集中在此，所有停止路径（Stop/onCoreStopped/onDispose/apply→stopRuntime）共用。
  function cancelAutoStart() {
    if (autoStartTimer) {
      clearInterval(autoStartTimer)
      autoStartTimer = null
    }
  }

  // 内核数据就绪判定：running 置位 ≠ 代理列表已加载。
  // 宿主的 useKernelApiStore().proxies 是内核起来之后异步拉取的；若仅凭 running 就 start()，
  // 此刻 proxies 为空 ⇒ build 里每个组都走 missing ⇒ groups 为空 ⇒ 抛「未匹配到任何可接管的策略组」
  // ⇒ 表现「重启后自动启动失败并弹红字，过一会儿手动点却成功」。
  const coreHasProxies = () => {
    try {
      const proxies = core.getStore()?.proxies
      return !!proxies && Object.keys(proxies).length > 0
    } catch (e) {
      return false
    }
  }

  /*
   * 自动接管统一入口（onReady / onCoreStarted 共用）。
   * 条件：内核 running 且代理数据已就绪；否则轮询等待（2s 一步，上限 60s）。
   * 重入时先清掉上一个等待定时器，避免两个定时器各起一次。
   */
  const autoStart = () => {
    // PATCH11#2：重入时先清掉旧的等待定时器（含「内核已就绪、直接启动」这条分支，旧版漏清 ⇒ 两个定时器各起一次）。
    cancelAutoStart()
    if (core.isRunning() && coreHasProxies()) return start()
    const timeoutMs = 60000
    const intervalMs = 2000
    let waited = 0
    // PATCH11#3：进入等待态立即让注册表反映「未运行/等待接管」，避免 onReady 同步返回后状态仍停留旧值。
    setPluginStatus(STATUS_STOPPED)
    autoStartTimer = setInterval(() => {
      if (core.isRunning() && coreHasProxies()) {
        cancelAutoStart()
        try {
          start()
        } catch (e) {
          setPluginStatus(STATUS_ERROR)
          Plugins.message.error('自动接管失败：' + (e?.message || String(e)))
        }
      } else if ((waited += intervalMs) >= timeoutMs) {
        cancelAutoStart()
        console.warn(SPS_TAG, '等待内核/代理数据就绪超时（60s），未自动接管；可手动点「启动」')
        setPluginStatus(STATUS_STOPPED)
      }
    }, intervalMs)
    return STATUS_STOPPED
  }

  const uiAlive = () => {
    try {
      return !!document.querySelector('div[data-title="' + UI_TITLE + '"]')
    } catch (e) {
      return false
    }
  }

  const openUI = () => {
    if (uiOpen && uiAlive()) return null

    pushDataVersion = () => {
      dataVersion.value += 1
    }

    const onClosed = () => {
      uiOpen = false
      pushDataVersion = null
    }

    const component = {
      template: `
    <Card>
      <template #title-suffix>
        <div class="font-bold">
          运行状态：{{ isRunning ? '运行中' : '已停止' }}{{ roundInfo ? ' · ' + roundInfo : '' }}{{ lastSwitchText ? ' · ' + lastSwitchText : '' }}{{ externalNotice }}
        </div>
      </template>
      <template #extra>
        <Button v-if="isRunning" type="primary" icon="pause" @click="handleStop()">停止</Button>
        <Button v-else type="primary" icon="play" @click="handleStart()">启动</Button>
      </template>
      <Empty v-if="!isRunning" />
      <Tabs v-else :items="tabs" v-model:active-key="tab" tabPosition="top" />
    </Card>`,
      setup() {
        const { h, ref, computed, watch, resolveComponent, onUnmounted } = Vue

        let cachedVersion = -1
        let cachedSets = null
        const rowSets = computed(() => {
          const version = dataVersion.value
          if (version === cachedVersion && cachedSets) return cachedSets
          cachedVersion = version
          cachedSets = buildRowSets(managers.value, Date.now())
          return cachedSets
        })

        const columns = [
          {
            title: '节点名',
            key: 'id',
            align: 'center',
            customRender: ({ value, record }) => {
              if (!record._selected) return value
              return h(resolveComponent('Tag'), { color: 'green' }, () => value)
            },
          },
          // PATCH3-P3：排序键是数值 scoreValue，不再解析显示字符串
          { title: '分数', key: 'score', align: 'center', sort: (a, b) => a.scoreValue - b.scoreValue },
          { title: '当前延迟', key: 'lastDelay', align: 'center' },
          { title: '测速地址', key: 'testHost', align: 'center' },
          { title: 'EWMA平滑延迟', key: 'ewmaLatency', align: 'center' },
          { title: '失败次数', key: 'failureCount', align: 'center' },
          { title: '全池样本 ✅/❌', key: 'fullProbeSample', align: 'center' },
          { title: '快检连败', key: 'currentProbeStreak', align: 'center' },
          { title: '惩罚值(衰减后)', key: 'penalty', align: 'center' },
          {
            title: '更新时间',
            key: 'lastPenaltyUpdate',
            align: 'center',
            customRender: ({ value }) => Plugins.formatRelativeTime(value),
          },
          {
            title: '下次检测时间',
            key: 'nextAttempt',
            align: 'center',
            customRender: ({ value }) => (value ? Plugins.formatRelativeTime(value) : '-'),
          },
          {
            title: '断路器',
            key: 'state',
            align: 'center',
            customRender: ({ value }) => {
              switch (value) {
                case 'CLOSED':
                  return '🟢 正常'
                case 'OPEN':
                  return '🔴 故障'
                case 'HALF_OPEN':
                  return '🟡 检测中'
                default:
                  return '❓未知'
              }
            },
          },
          { title: '可用性', key: 'isAvailable', align: 'center' },
        ]

        const tab = ref(null)
        const tabs = computed(() =>
          rowSets.value.map((item) => ({
            key: item.group,
            tab: item.group,
            component: () => h(resolveComponent('Table'), { dataSource: item.rows, columns }),
          })),
        )

        watch(
          () => rowSets.value.map((item) => item.group),
          (names) => {
            if (names.length === 0) {
              tab.value = null
              return
            }
            if (!names.includes(tab.value)) tab.value = names[0]
          },
          { immediate: true },
        )

        // PATCH4-M8：把「已暂停切换」的原因显示出来，否则用户只会看到插件突然不动了
        const externalNotice = computed(() => {
          dataVersion.value
          const names = managers.value.filter((manager) => manager.externalSelection).map((manager) => manager.group)
          if (names.length === 0) return ''
          return ' · 已暂停切换（内核当前选择不在插件管理范围内：' + names.join(' / ') + '）'
        })

        const lastSwitchText = computed(() => {
          dataVersion.value
          const info = managers.value
            .map((manager) => manager.lastSwitchInfo)
            .filter(Boolean)
            .sort((a, b) => b.at - a.at)[0]
          if (!info) return ''
          return '上次切换：' + info.from + ' → ' + info.to + '（' + info.reason + '）'
        })

        const roundInfo = computed(() => {
          dataVersion.value
          const costs = managers.value.map((manager) => manager.lastRoundCostMs).filter((value) => value > 0)
          if (costs.length === 0) return ''
          return '上轮耗时 ' + (Math.max.apply(null, costs) / 1000).toFixed(1) + 's'
        })

        if (typeof onUnmounted === 'function') onUnmounted(onClosed)

        return {
          isRunning,
          tab,
          tabs,
          externalNotice,
          lastSwitchText,
          roundInfo,
          handleStart() {
            try {
              start()
            } catch (error) {
              Plugins.message.error(error.message || String(error))
            }
          },
          handleStop() {
            stopRuntime()
          },
        }
      },
    }

    const modal = Plugins.modal(
      {
        title: UI_TITLE,
        maskClosable: true,
        submit: false,
        width: '90',
        height: '90',
        cancelText: 'common.close',
        afterClose: onClosed,
        afterDestroy: onClosed,
      },
      { default: () => Vue.h(component) },
    )

    uiOpen = true
    modal.open()
    return modal
  }

  return {
    onRun: () => {
      try {
        openUI()
      } catch (error) {
        uiOpen = false
        pushDataVersion = null
        console.warn(SPS_TAG, '打开面板失败：', error?.message || error)
        Plugins.message.error('打开面板失败：' + (error?.message || error))
      }
    },

    onReady: () => {
      try {
        // 自动接管：等「内核 running + 代理数据已加载」两者都满足再 start()（见 autoStart）。
        return autoStart()
      } catch (error) {
        // PATCH5-3：这是「App 启动后自动接管」的路径，失败只写日志会让用户完全看不见。
        Plugins.message.error('自动接管失败（onReady）：' + (error?.message || String(error)))
        return failStatus()
      }
    },

    onConfigure: (config) => {
      try {
        return start(config, true)
      } catch (error) {
        Plugins.message.error(error?.message || String(error))
        return failStatus()
      }
    },

    onCoreStarted: () => {
      try {
        // 内核刚启动时 proxies 往往还是空的 ⇒ 同样走 autoStart 等数据就绪，不能直接 start()。
        return autoStart()
      } catch (error) {
        // PATCH5-3：内核重启后的自动接管路径，同上。
        Plugins.message.error('自动接管失败（onCoreStarted）：' + (error?.message || String(error)))
        return failStatus()
      }
    },

    onCoreStopped: () => stopRuntime(),
    onDispose: () => stopRuntime(),

    Start: () => {
      try {
        return start()
      } catch (error) {
        Plugins.message.error(error?.message || String(error))
        return failStatus()
      }
    },

    Stop: () => stopRuntime(),
  }
}
