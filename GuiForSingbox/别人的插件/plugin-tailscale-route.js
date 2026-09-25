/** @type {EsmPlugin} */
export default (Plugin) => {
  const STORAGE_ID = Plugin.id || 'plugin-tailscale-route'
  const STORAGE_KEY = `${STORAGE_ID}:config:v2`
  const PEERS_CACHE_KEY = `${STORAGE_ID}:peers:v2`

  const DEFAULT_ENDPOINT_TAG = 'ts-ep'
  const DEFAULT_DNS_TAG = 'Tailscale-DNS'
  const DEFAULT_CIDRS = '100.64.0.0/10, fd7a:115c:a1e0::/48'
  const DEFAULT_DOMAINS = 'ts.net'
  const DEFAULT_SYSTEM_INTERFACE_NAME = 'tailscale-gfs'
  const DEFAULT_SYSTEM_INTERFACE_MTU = 1280
  const DEFAULT_STATE_DIRECTORY = 'tailscale'

  const WECHAT_DOMAIN_SUFFIXES = [
    'weixin.qq.com',
    'weixin.qq.com.cn',
    'weixinbridge.com',
    'qpic.cn',
    'qlogo.cn',
    'mmbiz.cn',
    'wxs.qq.com'
  ]

  const text = (value, fallback = '') => {
    if (value === undefined || value === null) return fallback
    const normalized = String(value).trim()
    return normalized || fallback
  }

  const rawText = (value) => {
    if (value === undefined || value === null) return ''
    return String(value).trim()
  }

  const unique = (items) => [...new Set(items)]

  const csv = (value, fallback = '') => {
    const source = value === undefined || value === null ? fallback : value
    return unique(
      String(source)
        .split(/[,\n\uFF0C\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  }

  const normalizeDomainSuffixList = (items) =>
    unique(items.map((item) => item.replace(/^\*\./, '').replace(/^\./, '').toLowerCase()).filter(Boolean))

  const domainSuffixes = (value, fallback = '') => normalizeDomainSuffixList(csv(value, fallback))

  const bool = (value, fallback = false) => {
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'boolean') return value
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
  }

  const positiveInteger = (value, fallback = 0) => {
    const parsed = Number.parseInt(String(value ?? '').trim(), 10)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
  }

  const maskSecret = (value) => {
    const secret = rawText(value)
    if (!secret) return '未填写'
    if (secret.length <= 12) return '已填写'
    return `${secret.slice(0, 8)}...${secret.slice(-4)}`
  }

  const getDefaultSettings = () => ({
    endpointTag: text(Plugin.EndpointTag, DEFAULT_ENDPOINT_TAG),
    dnsTag: text(Plugin.DnsTag, DEFAULT_DNS_TAG),
    routeCIDRs: text(Plugin.RouteCIDRs, DEFAULT_CIDRS),
    extraRouteCIDRs: text(Plugin.ExtraRouteCIDRs, ''),
    domainSuffixes: text(Plugin.DomainSuffixes, DEFAULT_DOMAINS),
    routeSingleLabelDomains: bool(Plugin.RouteSingleLabelDomains, true),
    acceptSearchDomain: bool(Plugin.AcceptSearchDomain, true),
    acceptRoutes: bool(Plugin.AcceptRoutes, true),
    systemInterface: bool(Plugin.SystemInterface, false),
    systemInterfaceName: text(Plugin.SystemInterfaceName, DEFAULT_SYSTEM_INTERFACE_NAME),
    systemInterfaceMtu: positiveInteger(Plugin.SystemInterfaceMtu, DEFAULT_SYSTEM_INTERFACE_MTU),
    authKey: rawText(Plugin.AuthKey),
    injectAuthKey: bool(Plugin.InjectAuthKey, false),
    hostname: rawText(Plugin.Hostname),
    controlUrl: rawText(Plugin.ControlURL),
    controlDetour: rawText(Plugin.ControlDetour),
    exitNode: rawText(Plugin.ExitNode),
    udpTimeout: rawText(Plugin.UdpTimeout),
    stateDirectory: text(Plugin.StateDirectory, DEFAULT_STATE_DIRECTORY),
    fixWechatBypass: bool(Plugin.FixWechatBypass, false),
    apiToken: rawText(Plugin.ApiToken),
    tailnetName: text(Plugin.TailnetName, '-')
  })

  const loadSettings = () => {
    const defaults = getDefaultSettings()
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) {
          const parsed = JSON.parse(saved)
          return { ...defaults, ...parsed }
        }
      }
    } catch {
      // ignore storage error
    }
    return defaults
  }

  const saveSettings = (settings) => {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    }
  }

  const loadCachedPeers = () => {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem(PEERS_CACHE_KEY)
        if (saved) return JSON.parse(saved)
      }
    } catch {
      // ignore
    }
    return []
  }

  const saveCachedPeers = (peers) => {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(PEERS_CACHE_KEY, JSON.stringify(peers))
      }
    } catch {
      // ignore
    }
  }

  const replaceByTag = (items, tag, next) => {
    const index = items.findIndex((item) => item?.tag === tag)
    if (index === -1) {
      items.push(next)
    } else {
      items[index] = next
    }
  }

  const insertBeforePrivateOrDirect = (rules, newRule) => {
    const isPrivateOrDirect = (item) => {
      if (item?.ip_is_private === true) return true
      if (Array.isArray(item?.rule_set) && item.rule_set.some((r) => /private/i.test(r))) return true
      if (item?.action === 'route' && /direct/i.test(item?.outbound || '')) return true
      return false
    }

    const index = rules.findIndex(isPrivateOrDirect)
    if (index !== -1) {
      rules.splice(index, 0, newRule)
    } else {
      rules.unshift(newRule)
    }
  }

  const insertBeforeFakeIpDns = (rules, dnsServers, newRule) => {
    const fakeIpTags = new Set(
      (dnsServers || []).filter((s) => s?.type === 'fakeip' || /fake[-_]?ip/i.test(s?.tag || '')).map((s) => s.tag)
    )
    const isFakeIpRule = (rule) =>
      rule?.action === 'route' && (fakeIpTags.has(rule?.server) || /fake[-_]?ip/i.test(rule?.server || ''))

    const index = rules.findIndex(isFakeIpRule)
    if (index !== -1) {
      rules.splice(index, 0, newRule)
    } else {
      rules.unshift(newRule)
    }
  }

  const buildEndpoint = (settings, endpointTag) => {
    const endpoint = {
      type: 'tailscale',
      tag: endpointTag,
      state_directory: text(settings.stateDirectory, DEFAULT_STATE_DIRECTORY),
      accept_routes: bool(settings.acceptRoutes, true),
      system_interface: bool(settings.systemInterface, false)
    }

    const authKey = rawText(settings.authKey)
    const hostname = rawText(settings.hostname)
    const controlUrl = rawText(settings.controlUrl)
    const controlDetour = rawText(settings.controlDetour)
    const exitNode = rawText(settings.exitNode)
    const systemInterfaceName = rawText(settings.systemInterfaceName)
    const systemInterfaceMtu = positiveInteger(settings.systemInterfaceMtu, 0)
    const udpTimeout = rawText(settings.udpTimeout)

    if (authKey && bool(settings.injectAuthKey, false)) endpoint.auth_key = authKey
    if (hostname) endpoint.hostname = hostname
    if (controlUrl) endpoint.control_url = controlUrl
    if (controlDetour) endpoint.detour = controlDetour
    if (exitNode) endpoint.exit_node = exitNode
    if (endpoint.system_interface) {
      endpoint.system_interface_name = systemInterfaceName || DEFAULT_SYSTEM_INTERFACE_NAME
      if (systemInterfaceMtu) endpoint.system_interface_mtu = systemInterfaceMtu
    }
    if (udpTimeout) endpoint.udp_timeout = udpTimeout

    return endpoint
  }

  const patchConfig = (config, customSettings = null, notify = false) => {
    if (!config || typeof config !== 'object') {
      throw new Error('无效的 sing-box 配置对象')
    }

    const settings = customSettings || loadSettings()
    const endpointTag = text(settings.endpointTag, DEFAULT_ENDPOINT_TAG)
    const dnsTag = text(settings.dnsTag, DEFAULT_DNS_TAG)
    const cidrs = csv(settings.routeCIDRs, DEFAULT_CIDRS)
    const extraCidrs = csv(settings.extraRouteCIDRs, '')
    const domains = domainSuffixes(settings.domainSuffixes, DEFAULT_DOMAINS)
    const allCidrs = unique([...cidrs, ...extraCidrs])

    if (!allCidrs.length && !domains.length) {
      throw new Error('Tailscale 分流插件没有可匹配的 CIDR 或域名后缀')
    }

    // 1. 注入/更新 Tailscale Endpoint
    config.endpoints ??= []
    replaceByTag(config.endpoints, endpointTag, buildEndpoint(settings, endpointTag))

    // 2. DNS 配置处理（按 tag 精准清理旧规则，严禁注入私有标记避免 unknown field 报错）
    config.dns ??= {}
    config.dns.servers ??= []
    config.dns.rules ??= []
    config.dns.rules = config.dns.rules.filter((rule) => rule?.server !== dnsTag)

    if (domains.length) {
      replaceByTag(config.dns.servers, dnsTag, {
        type: 'tailscale',
        tag: dnsTag,
        endpoint: endpointTag,
        accept_search_domain: bool(settings.acceptSearchDomain, true)
      })

      // 注入在 FakeIP 之前，确保 Tailscale 域名解析为真实内网 IP
      insertBeforeFakeIpDns(config.dns.rules, config.dns.servers, {
        action: 'route',
        domain_suffix: domains,
        server: dnsTag
      })

      // 可选：短主机名单标签解析转发（如 nas, router 等）
      if (bool(settings.routeSingleLabelDomains, true)) {
        insertBeforeFakeIpDns(config.dns.rules, config.dns.servers, {
          action: 'route',
          domain_regex: ['^[^.]+$'],
          server: dnsTag
        })
      }
    } else {
      config.dns.servers = config.dns.servers.filter((server) => server?.tag !== dnsTag)
    }

    // 3. 路由规则处理（按 outbound 精准清理旧规则）
    config.route ??= {}
    config.route.rules ??= []
    config.route.rules = config.route.rules.filter((rule) => rule?.outbound !== endpointTag)

    // 核心修复：sing-box 单条规则内部不同匹配字段间为逻辑与 (AND)
    // 必须拆分为独立规则：纯 IP 连接才能命中 ip_cidr 规则
    if (domains.length) {
      insertBeforePrivateOrDirect(config.route.rules, {
        action: 'route',
        domain_suffix: domains,
        outbound: endpointTag
      })
    }
    if (allCidrs.length) {
      insertBeforePrivateOrDirect(config.route.rules, {
        action: 'route',
        ip_cidr: allCidrs,
        outbound: endpointTag
      })
    }

    // 4. 可选：微信直连及 IPv6 AAAA 优化（默认关闭）
    const isWechatRule = (rule) =>
      Array.isArray(rule?.domain_suffix) &&
      rule.domain_suffix.some((domain) => domain === 'weixin.qq.com' || domain === 'weixin.qq.com.cn')

    config.dns.rules = config.dns.rules.filter((rule) => !isWechatRule(rule))
    config.route.rules = config.route.rules.filter((rule) => !isWechatRule(rule))

    if (bool(settings.fixWechatBypass, false)) {
      const directOutbound = config.outbounds?.find((outbound) => outbound?.type === 'direct')?.tag || 'DIRECT'
      insertBeforeFakeIpDns(config.dns.rules, config.dns.servers, {
        action: 'predefined',
        domain_suffix: WECHAT_DOMAIN_SUFFIXES,
        query_type: ['AAAA'],
        rcode: 'NOERROR'
      })
      insertBeforePrivateOrDirect(config.route.rules, {
        action: 'route',
        domain_suffix: WECHAT_DOMAIN_SUFFIXES,
        outbound: directOutbound
      })
    }

    if (notify) {
      if (!rawText(settings.authKey)) {
        Plugins.message.warn('Tailscale AuthKey 为空。首次接入请开启控制台或检查持久化目录状态。')
      } else if (!bool(settings.injectAuthKey, false)) {
        Plugins.message.info('已配置 Tailscale AuthKey，当前未开启“启动时注入”（仅首次接入需要开启）。')
      }
    }

    return config
  }

  const injectStyle = () => {
    const styleId = 'gfs-tailscale-plugin-style'
    if (document.getElementById(styleId)) return

    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `
      .ts-modal {
        --ts-bg: #ffffff;
        --ts-card: #f8fafc;
        --ts-card-sub: #f1f5f9;
        --ts-border: #e2e8f0;
        --ts-border-light: #edf2f7;
        --ts-text: #0f172a;
        --ts-text-muted: #64748b;
        --ts-text-sub: #94a3b8;
        --ts-accent: #2563eb;
        --ts-accent-hover: #1d4ed8;
        --ts-accent-soft: rgba(37, 99, 235, 0.08);
        --ts-accent-border: rgba(37, 99, 235, 0.25);
        --ts-good: #16a34a;
        --ts-good-bg: rgba(22, 163, 74, 0.08);
        --ts-good-border: rgba(22, 163, 74, 0.25);
        --ts-warn: #d97706;
        --ts-warn-bg: rgba(217, 119, 6, 0.08);
        --ts-warn-border: rgba(217, 119, 6, 0.25);
        --ts-bad: #dc2626;
        --ts-bad-bg: rgba(220, 38, 38, 0.08);
        --ts-bad-border: rgba(220, 38, 38, 0.25);

        background: var(--ts-bg);
        color: var(--ts-text);
        padding: 16px;
        border-radius: 12px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        box-sizing: border-box;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        height: min(780px, calc(100vh - 90px));
      }

      html.dark .ts-modal, body.dark .ts-modal, .dark .ts-modal, [data-theme="dark"] .ts-modal {
        --ts-bg: #0b0f19;
        --ts-card: #131d31;
        --ts-card-sub: #1a2640;
        --ts-border: #233354;
        --ts-border-light: #1c2b47;
        --ts-text: #f8fafc;
        --ts-text-muted: #94a3b8;
        --ts-text-sub: #64748b;
        --ts-accent: #3b82f6;
        --ts-accent-hover: #60a5fa;
        --ts-accent-soft: rgba(59, 130, 246, 0.12);
        --ts-accent-border: rgba(59, 130, 246, 0.35);
        --ts-good: #4ade80;
        --ts-good-bg: rgba(34, 197, 94, 0.12);
        --ts-good-border: rgba(34, 197, 94, 0.28);
        --ts-warn: #fbbf24;
        --ts-warn-bg: rgba(245, 158, 11, 0.12);
        --ts-warn-border: rgba(245, 158, 11, 0.28);
        --ts-bad: #f87171;
        --ts-bad-bg: rgba(239, 68, 68, 0.14);
        --ts-bad-border: rgba(239, 68, 68, 0.32);
      }

      .ts-modal * { box-sizing: border-box; }

      /* Topbar */
      .ts-topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex: 0 0 auto;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--ts-border);
      }
      .ts-brand {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .ts-title {
        font-size: 17px;
        font-weight: 800;
        color: var(--ts-text);
        letter-spacing: -0.2px;
      }
      .ts-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
      }
      .ts-badge.kernel {
        background: var(--ts-accent-soft);
        color: var(--ts-accent);
        border: 1px solid var(--ts-accent-border);
      }
      .ts-badge.mode-tun {
        background: var(--ts-warn-bg);
        color: var(--ts-warn);
        border: 1px solid var(--ts-warn-border);
      }
      .ts-badge.mode-user {
        background: var(--ts-good-bg);
        color: var(--ts-good);
        border: 1px solid var(--ts-good-border);
      }

      .ts-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ts-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        border-radius: 6px;
        border: 1px solid var(--ts-border);
        background: var(--ts-card);
        color: var(--ts-text);
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .ts-btn:hover {
        background: var(--ts-card-sub);
        border-color: var(--ts-text-muted);
      }
      .ts-btn-primary {
        background: var(--ts-accent);
        color: #fff;
        border-color: var(--ts-accent);
      }
      .ts-btn-primary:hover {
        background: var(--ts-accent-hover);
      }
      .ts-btn-accent {
        background: var(--ts-accent-soft);
        color: var(--ts-accent);
        border-color: var(--ts-accent-border);
      }
      .ts-btn-accent:hover {
        background: var(--ts-accent);
        color: #fff;
      }
      .ts-btn-sm {
        padding: 3px 8px;
        font-size: 11px;
        border-radius: 5px;
      }

      /* Tabs Navigation */
      .ts-nav {
        display: flex;
        align-items: center;
        gap: 6px;
        border-bottom: 1px solid var(--ts-border);
        flex: 0 0 auto;
      }
      .ts-nav-item {
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 600;
        color: var(--ts-text-muted);
        border-bottom: 2px solid transparent;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ts-nav-item:hover {
        color: var(--ts-text);
      }
      .ts-nav-item.active {
        color: var(--ts-accent);
        border-bottom-color: var(--ts-accent);
      }
      .ts-nav-tag {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 999px;
        background: var(--ts-accent-soft);
        color: var(--ts-accent);
      }

      /* Content Area */
      .ts-content {
        flex: 1 1 0;
        min-height: 0;
        overflow-y: auto;
        padding-right: 4px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      /* Form Cards */
      .ts-card {
        background: var(--ts-card);
        border: 1px solid var(--ts-border);
        border-radius: 8px;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .ts-card-head {
        font-size: 13px;
        font-weight: 700;
        color: var(--ts-text);
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--ts-border-light);
        padding-bottom: 8px;
      }
      .ts-card-sub {
        font-size: 12px;
        color: var(--ts-text-muted);
        font-weight: normal;
      }

      /* Form Rows & Inputs */
      .ts-form-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }
      .ts-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .ts-field.full {
        grid-column: span 2;
      }
      .ts-label {
        font-size: 12px;
        font-weight: 600;
        color: var(--ts-text);
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .ts-label-sub {
        font-size: 11px;
        font-weight: normal;
        color: var(--ts-text-muted);
      }
      .ts-input, .ts-textarea {
        background: var(--ts-card-sub);
        border: 1px solid var(--ts-border);
        border-radius: 6px;
        padding: 8px 10px;
        color: var(--ts-text);
        font-size: 12px;
        outline: none;
        transition: border-color 0.15s ease;
        width: 100%;
      }
      .ts-input:focus, .ts-textarea:focus {
        border-color: var(--ts-accent);
        background: var(--ts-bg);
      }
      .ts-textarea {
        resize: vertical;
        min-height: 56px;
        font-family: Consolas, monospace;
        line-height: 18px;
      }

      /* Toggles & Checkbox Rows */
      .ts-switch-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 10px;
        background: var(--ts-card-sub);
        border: 1px solid var(--ts-border);
        border-radius: 6px;
      }
      .ts-switch-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .ts-switch-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--ts-text);
      }
      .ts-switch-desc {
        font-size: 11px;
        color: var(--ts-text-muted);
      }

      /* Toggle Switch */
      .ts-toggle {
        position: relative;
        display: inline-block;
        width: 38px;
        height: 20px;
        flex-shrink: 0;
      }
      .ts-toggle input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .ts-toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0; left: 0; right: 0; bottom: 0;
        background-color: var(--ts-border);
        transition: 0.2s;
        border-radius: 20px;
      }
      .ts-toggle-slider:before {
        position: absolute;
        content: "";
        height: 14px;
        width: 14px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        transition: 0.2s;
        border-radius: 50%;
      }
      .ts-toggle input:checked + .ts-toggle-slider {
        background-color: var(--ts-accent);
      }
      .ts-toggle input:checked + .ts-toggle-slider:before {
        transform: translateX(18px);
      }

      /* Alert Box */
      .ts-alert-box {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 17px;
      }
      .ts-alert-box.info {
        background: var(--ts-accent-soft);
        color: var(--ts-accent);
        border: 1px solid var(--ts-accent-border);
      }
      .ts-alert-box.warn {
        background: var(--ts-warn-bg);
        color: var(--ts-warn);
        border: 1px solid var(--ts-warn-border);
      }

      /* Preview Code Area */
      .ts-preview-box {
        background: var(--ts-card-sub);
        border: 1px solid var(--ts-border);
        border-radius: 8px;
        padding: 12px;
        font-family: Consolas, monospace;
        font-size: 12px;
        line-height: 18px;
        color: var(--ts-text);
        overflow-x: auto;
        max-height: 440px;
        white-space: pre;
      }

      /* Peers Grid & Card */
      .ts-peers-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .ts-peers-stats {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        color: var(--ts-text-muted);
      }
      .ts-peer-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
        gap: 12px;
      }
      .ts-peer-card {
        background: var(--ts-card);
        border: 1px solid var(--ts-border);
        border-radius: 8px;
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .ts-peer-card:hover {
        border-color: var(--ts-accent-border);
      }
      .ts-peer-card.is-exit {
        border-left: 3px solid var(--ts-warn);
      }
      .ts-peer-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .ts-peer-name-wrap {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      .ts-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .ts-dot.online {
        background: var(--ts-good);
        box-shadow: 0 0 0 2px var(--ts-good-border);
      }
      .ts-dot.offline {
        background: var(--ts-text-sub);
      }
      .ts-peer-hostname {
        font-size: 14px;
        font-weight: 700;
        color: var(--ts-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ts-os-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 4px;
        background: var(--ts-card-sub);
        border: 1px solid var(--ts-border);
        color: var(--ts-text-muted);
        text-transform: capitalize;
        flex-shrink: 0;
      }
      .ts-peer-magic-dns {
        font-size: 11px;
        color: var(--ts-text-muted);
        font-family: Consolas, monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .ts-peer-ips {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-family: Consolas, monospace;
        font-size: 11px;
        background: var(--ts-card-sub);
        padding: 6px 8px;
        border-radius: 5px;
        border: 1px solid var(--ts-border-light);
      }
      .ts-peer-ip-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .ts-ip-val {
        color: var(--ts-text);
      }
      .ts-peer-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .ts-tag {
        font-size: 10px;
        font-weight: 700;
        padding: 2px 6px;
        border-radius: 4px;
      }
      .ts-tag.exit {
        background: var(--ts-warn-bg);
        color: var(--ts-warn);
        border: 1px solid var(--ts-warn-border);
      }
      .ts-tag.subnet {
        background: var(--ts-accent-soft);
        color: var(--ts-accent);
        border: 1px solid var(--ts-accent-border);
      }
      .ts-tag.self {
        background: var(--ts-good-bg);
        color: var(--ts-good);
        border: 1px solid var(--ts-good-border);
      }
      .ts-peer-actions {
        display: flex;
        gap: 6px;
        margin-top: 2px;
        padding-top: 6px;
        border-top: 1px solid var(--ts-border-light);
      }
      .ts-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 40px 20px;
        background: var(--ts-card);
        border: 1px dashed var(--ts-border);
        border-radius: 8px;
        color: var(--ts-text-muted);
        text-align: center;
      }
    `
    document.head.appendChild(style)
  }

  const openUI = () => {
    injectStyle()

    const modal = Plugins.modal({
      title: `${Plugin.name || 'Tailscale 分流路由'} 管理面板`,
      width: 980,
      cancelText: '关闭',
      submit: false,
      afterClose: () => {
        modal.destroy()
      }
    })

    const { defineComponent, ref, reactive, computed, onMounted } = Vue

    const component = defineComponent({
      template: `
        <div class="ts-modal">
          <!-- Topbar -->
          <div class="ts-topbar">
            <div class="ts-brand">
              <span class="ts-title">Tailscale 路由分流</span>
              <span class="ts-badge kernel">sing-box 1.14.0+</span>
              <span class="ts-badge" :class="form.systemInterface ? 'mode-tun' : 'mode-user'">
                {{ form.systemInterface ? 'Wintun 虚拟网卡' : '用户态 gVisor (免管理员)' }}
              </span>
            </div>
            <div class="ts-actions">
              <button class="ts-btn" @click="handleReset">恢复默认</button>
              <button class="ts-btn ts-btn-accent" @click="activeTab = 'preview'; handlePreview()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                实时预览
              </button>
              <button class="ts-btn ts-btn-primary" @click="handleSave">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                保存配置
              </button>
            </div>
          </div>

          <!-- Tabs Navigation -->
          <div class="ts-nav">
            <div class="ts-nav-item" :class="{ active: activeTab === 'routing' }" @click="activeTab = 'routing'">
              基础网络与分流
            </div>
            <div class="ts-nav-item" :class="{ active: activeTab === 'peers' }" @click="activeTab = 'peers'">
              同网设备预览
              <span v-if="peersList.length" class="ts-nav-tag">{{ peersList.length }}</span>
            </div>
            <div class="ts-nav-item" :class="{ active: activeTab === 'credentials' }" @click="activeTab = 'credentials'">
              接入凭据与节点
            </div>
            <div class="ts-nav-item" :class="{ active: activeTab === 'advanced' }" @click="activeTab = 'advanced'">
              运行环境与高级
            </div>
            <div class="ts-nav-item" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'; handlePreview()">
              生成配置预览
            </div>
          </div>

          <!-- Main Content Panels -->
          <div class="ts-content">
            <!-- TAB 1: 基础网络与分流 -->
            <div v-if="activeTab === 'routing'" style="display: flex; flex-direction: column; gap: 12px;">
              <div class="ts-card">
                <div class="ts-card-head">
                  <span>标签命名 (Tag)</span>
                  <span class="ts-card-sub">用于在 sing-box 核心内标识此 Endpoint 与 DNS 服务</span>
                </div>
                <div class="ts-form-grid">
                  <div class="ts-field">
                    <label class="ts-label">Endpoint 标签</label>
                    <input class="ts-input" v-model="form.endpointTag" placeholder="ts-ep" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">DNS 服务器标签</label>
                    <input class="ts-input" v-model="form.dnsTag" placeholder="Tailscale-DNS" />
                  </div>
                </div>
              </div>

              <div class="ts-card">
                <div class="ts-card-head">
                  <span>分流目标 CIDR 与域名</span>
                  <span class="ts-card-sub">命中以下网段或域名的流量将通过 Tailscale 端点中转</span>
                </div>
                <div class="ts-field full">
                  <label class="ts-label">
                    <span>Tailnet 基础路由 CIDR (逗号或换行分隔)</span>
                    <button class="ts-btn" style="padding: 2px 6px; font-size: 11px;" @click="fillDefaultCidrs">填入默认 IPv4+IPv6</button>
                  </label>
                  <textarea class="ts-textarea" v-model="form.routeCIDRs" placeholder="100.64.0.0/10, fd7a:115c:a1e0::/48"></textarea>
                </div>
                <div class="ts-field full">
                  <label class="ts-label">额外子网路由 CIDR (可选，多行或逗号分隔)</label>
                  <input class="ts-input" v-model="form.extraRouteCIDRs" placeholder="例如: 192.168.1.0/24, 10.0.0.0/24" />
                </div>
                <div class="ts-field full">
                  <label class="ts-label">Tailnet 域名后缀 (多行或逗号分隔)</label>
                  <input class="ts-input" v-model="form.domainSuffixes" placeholder="ts.net, my-tailnet.ts.net" />
                </div>
              </div>

              <div class="ts-card">
                <div class="ts-card-head">
                  <span>MagicDNS 增强选项</span>
                </div>
                <div class="ts-switch-row">
                  <div class="ts-switch-info">
                    <span class="ts-switch-title">解析单标签短主机名</span>
                    <span class="ts-switch-desc">允许直接在浏览器或终端输入设备名访问 (例如 http://nas/ 或 ping server)</span>
                  </div>
                  <label class="ts-toggle">
                    <input type="checkbox" v-model="form.routeSingleLabelDomains" />
                    <span class="ts-toggle-slider"></span>
                  </label>
                </div>
                <div class="ts-switch-row">
                  <div class="ts-switch-info">
                    <span class="ts-switch-title">接受搜索域 (Accept Search Domain)</span>
                    <span class="ts-switch-desc">向 Tailscale DNS 请求自动补全并解析 Tailnet 搜索域后缀</span>
                  </div>
                  <label class="ts-toggle">
                    <input type="checkbox" v-model="form.acceptSearchDomain" />
                    <span class="ts-toggle-slider"></span>
                  </label>
                </div>
                <div class="ts-switch-row">
                  <div class="ts-switch-info">
                    <span class="ts-switch-title">接受子网路由 (Accept Routes)</span>
                    <span class="ts-switch-desc">接受 Tailnet 内其他子网路由节点 (Subnet Router) 宣告的路由</span>
                  </div>
                  <label class="ts-toggle">
                    <input type="checkbox" v-model="form.acceptRoutes" />
                    <span class="ts-toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>

            <!-- TAB 2: 同网设备预览 (新增) -->
            <div v-if="activeTab === 'peers'" style="display: flex; flex-direction: column; gap: 12px;">
              <!-- API Token Settings Drawer/Bar -->
              <div class="ts-card" style="padding: 10px 14px;">
                <div class="ts-peers-toolbar">
                  <div class="ts-peers-stats">
                    <strong style="color: var(--ts-text); font-size: 13px;">同 Tailnet 网络设备</strong>
                    <span>(共 {{ peersList.length }} 台{{ onlineCount ? ' · ' + onlineCount + ' 在线' : '' }})</span>
                  </div>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <input class="ts-input" style="width: 160px; padding: 4px 8px; font-size: 11px;" v-model="peerSearch" placeholder="过滤节点名称或 IP..." />
                    <button class="ts-btn ts-btn-accent ts-btn-sm" :disabled="loadingPeers" @click="fetchDevices">
                      <svg v-if="!loadingPeers" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                      {{ loadingPeers ? '同步中...' : '同步在线设备' }}
                    </button>
                    <button class="ts-btn ts-btn-sm" @click="showApiConfig = !showApiConfig">
                      {{ showApiConfig ? '收起 API 配置' : '设置 API Token' }}
                    </button>
                  </div>
                </div>

                <!-- API Key Config Drawer -->
                <div v-if="showApiConfig" style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--ts-border-light); display: flex; flex-direction: column; gap: 8px;">
                  <div class="ts-form-grid">
                    <div class="ts-field">
                      <label class="ts-label">
                        <span>Tailscale API Access Token</span>
                        <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" style="color: var(--ts-accent); font-size: 11px; text-decoration: none;">获取只读 Token ↗</a>
                      </label>
                      <div style="display: flex; gap: 8px;">
                        <input :type="showApiToken ? 'text' : 'password'" class="ts-input" v-model="form.apiToken" placeholder="tskey-api-k..." />
                        <button class="ts-btn ts-btn-sm" @click="showApiToken = !showApiToken">{{ showApiToken ? '隐藏' : '显示' }}</button>
                        <button v-if="form.apiToken" class="ts-btn ts-btn-sm" @click="handleClearApiToken">清空</button>
                      </div>
                    </div>
                    <div class="ts-field">
                      <label class="ts-label">Tailnet 组织名称</label>
                      <input class="ts-input" v-model="form.tailnetName" placeholder="- (留空使用默认组织)" />
                    </div>
                  </div>
                  <div style="display: flex; justify-content: flex-end; gap: 8px;">
                    <button class="ts-btn ts-btn-sm ts-btn-primary" :disabled="loadingPeers" @click="handleSaveAndFetchApi">
                      {{ loadingPeers ? '同步中...' : '保存 Token 并同步' }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- Peers List Display -->
              <div v-if="filteredPeers.length" class="ts-peer-grid">
                <div v-for="dev in filteredPeers" :key="dev.id" class="ts-peer-card" :class="{ 'is-exit': dev.isExitNode }">
                  <div class="ts-peer-head">
                    <div class="ts-peer-name-wrap">
                      <span class="ts-dot" :class="dev.online ? 'online' : 'offline'" :title="dev.online ? '在线' : '离线'"></span>
                      <strong class="ts-peer-hostname" :title="dev.hostname">{{ dev.hostname }}</strong>
                      <span v-if="dev.os" class="ts-os-badge">{{ dev.os }}</span>
                    </div>
                    <span style="font-size: 11px; color: var(--ts-text-muted);">{{ dev.lastSeenText }}</span>
                  </div>

                  <div class="ts-peer-magic-dns" :title="dev.name">{{ dev.name }}</div>

                  <div class="ts-peer-ips">
                    <div class="ts-peer-ip-row">
                      <span class="ts-ip-val">IPv4: {{ dev.ipv4 || '-' }}</span>
                      <button v-if="dev.ipv4" class="ts-btn" style="padding: 1px 5px; font-size: 10px;" @click="copyText(dev.ipv4, 'IPv4 已复制')">复制</button>
                    </div>
                    <div v-if="dev.ipv6" class="ts-peer-ip-row" style="color: var(--ts-text-muted);">
                      <span>IPv6: {{ dev.ipv6 }}</span>
                    </div>
                  </div>

                  <!-- Role Badges -->
                  <div class="ts-peer-badges">
                    <span v-if="dev.isSelf" class="ts-tag self">本机 (当前节点)</span>
                    <span v-if="dev.isExitNode" class="ts-tag exit">🚀 出口节点 (Exit Node)</span>
                    <span v-if="dev.subnetRoutes && dev.subnetRoutes.length" class="ts-tag subnet">
                      📡 广播子网: {{ dev.subnetRoutes.join(', ') }}
                    </span>
                  </div>

                  <!-- Action Buttons -->
                  <div class="ts-peer-actions">
                    <button v-if="!dev.isSelf" class="ts-btn ts-btn-sm" :class="{ 'ts-btn-accent': dev.isExitNode }" @click="setAsExitNode(dev)">
                      ⭐ 设为出口节点
                    </button>
                    <button v-if="!dev.isSelf" class="ts-btn ts-btn-sm" @click="addNodeToRoute(dev)">
                      ➕ 加入分流网段
                    </button>
                    <button class="ts-btn ts-btn-sm" @click="copyText(dev.name, 'MagicDNS 域名已复制')">
                      📋 复制域名
                    </button>
                  </div>
                </div>
              </div>

              <!-- Empty State -->
              <div v-else class="ts-empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
                <div style="font-size: 14px; font-weight: 700; color: var(--ts-text);">
                  {{ form.apiToken ? '未匹配到符合条件的 Tailscale 节点' : '尚未配置 Tailscale API Token' }}
                </div>
                <div style="font-size: 12px; max-width: 480px; line-height: 18px;">
                  {{ form.apiToken ? '点击上方“同步在线设备”重新拉取最新的节点状态列表。' : '在上方点击“设置 API Token”，填入在 Tailscale 官网生成的只读 API Access Token，即可一键实时同步所有内网设备与出口节点！' }}
                </div>
                <button v-if="!form.apiToken" class="ts-btn ts-btn-primary" @click="showApiConfig = true">
                  立即配置 API Token
                </button>
              </div>
            </div>

            <!-- TAB 3: 接入凭据与节点 -->
            <div v-if="activeTab === 'credentials'" style="display: flex; flex-direction: column; gap: 12px;">
              <div class="ts-card">
                <div class="ts-card-head">
                  <span>授权密钥 (AuthKey)</span>
                </div>
                <div class="ts-field full">
                  <label class="ts-label">
                    <span>Tailscale / Headscale AuthKey</span>
                    <span class="ts-label-sub">{{ authKeyStatusText }}</span>
                  </label>
                  <div style="display: flex; gap: 8px;">
                    <input :type="showAuthKey ? 'text' : 'password'" class="ts-input" v-model="form.authKey" placeholder="tskey-auth-xxxxxx" />
                    <button class="ts-btn" @click="showAuthKey = !showAuthKey">{{ showAuthKey ? '隐藏' : '显示' }}</button>
                  </div>
                </div>
                <div class="ts-switch-row">
                  <div class="ts-switch-info">
                    <span class="ts-switch-title">启动时注入 AuthKey</span>
                    <span class="ts-switch-desc">仅在首次注册新节点或更换密钥时开启；成功加入 tailnet 后建议关闭避免重复注册</span>
                  </div>
                  <label class="ts-toggle">
                    <input type="checkbox" v-model="form.injectAuthKey" />
                    <span class="ts-toggle-slider"></span>
                  </label>
                </div>
                <div class="ts-alert-box info">
                  <span>提示：若未注入 AuthKey，且状态目录为空，sing-box 会在终端/日志中输出交互式登录链接。</span>
                </div>
              </div>

              <div class="ts-card">
                <div class="ts-card-head">
                  <span>节点与协调服务器</span>
                </div>
                <div class="ts-form-grid">
                  <div class="ts-field">
                    <label class="ts-label">自定义主机名 (Hostname)</label>
                    <input class="ts-input" v-model="form.hostname" placeholder="留空默认使用系统计算机名" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">协调服务器 URL (Control URL)</label>
                    <input class="ts-input" v-model="form.controlUrl" placeholder="留空使用官方，Headscale 可填 https://your-server" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">出口节点 (Exit Node)</label>
                    <input class="ts-input" v-model="form.exitNode" placeholder="例如: exit-node-hostname 或 100.x.x.x" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">控制面绕行出站 (Detour)</label>
                    <input class="ts-input" v-model="form.controlDetour" placeholder="留空走默认路由，如需直连填 DIRECT" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">UDP 超时时间 (Udp Timeout)</label>
                    <input class="ts-input" v-model="form.udpTimeout" placeholder="例如: 5m" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">持久化状态目录 (State Directory)</label>
                    <input class="ts-input" v-model="form.stateDirectory" placeholder="tailscale" />
                  </div>
                </div>
              </div>
            </div>

            <!-- TAB 4: 运行环境与高级 -->
            <div v-if="activeTab === 'advanced'" style="display: flex; flex-direction: column; gap: 12px;">
              <div class="ts-card">
                <div class="ts-card-head">
                  <span>网络模式 (TUN 虚拟网卡 vs 用户态 gVisor)</span>
                </div>
                <div class="ts-switch-row">
                  <div class="ts-switch-info">
                    <span class="ts-switch-title">创建操作系统 TUN 虚拟网卡 (System Interface)</span>
                    <span class="ts-switch-desc">默认关闭（推荐）：使用 sing-box 内置 gVisor 网络栈，免 Windows 管理员权限即可稳定转发</span>
                  </div>
                  <label class="ts-toggle">
                    <input type="checkbox" v-model="form.systemInterface" />
                    <span class="ts-toggle-slider"></span>
                  </label>
                </div>
                <div v-if="form.systemInterface" class="ts-alert-box warn">
                  <span>注意：开启虚拟网卡模式要求 GFS 必须“以管理员身份运行”，否则内核启动将报错拒绝访问。</span>
                </div>
                <div v-if="form.systemInterface" class="ts-form-grid">
                  <div class="ts-field">
                    <label class="ts-label">虚拟网卡名称</label>
                    <input class="ts-input" v-model="form.systemInterfaceName" placeholder="tailscale-gfs" />
                  </div>
                  <div class="ts-field">
                    <label class="ts-label">网卡 MTU</label>
                    <input class="ts-input" v-model.number="form.systemInterfaceMtu" placeholder="1280" />
                  </div>
                </div>
              </div>

              <div class="ts-card">
                <div class="ts-card-head">
                  <span>可选网络优化</span>
                </div>
                <div class="ts-switch-row">
                  <div class="ts-switch-info">
                    <span class="ts-switch-title">微信直连分流与 IPv6 AAAA 阻断</span>
                    <span class="ts-switch-desc">解决部分网络环境下微信偶发延迟、连接缓慢问题（注入微信域名直连与 AAAA NOERROR 清空）</span>
                  </div>
                  <label class="ts-toggle">
                    <input type="checkbox" v-model="form.fixWechatBypass" />
                    <span class="ts-toggle-slider"></span>
                  </label>
                </div>
              </div>
            </div>

            <!-- TAB 5: 配置生成预览 -->
            <div v-if="activeTab === 'preview'" style="display: flex; flex-direction: column; gap: 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 13px; font-weight: 700; color: var(--ts-text);">基于当前 GFS 活跃 Profile 生成的注入结果</span>
                <button class="ts-btn" @click="handlePreview" :disabled="previewing">
                  {{ previewing ? '生成中...' : '刷新预览' }}
                </button>
              </div>
              <div v-if="previewError" class="ts-alert-box warn">
                <span>{{ previewError }}</span>
              </div>
              <pre class="ts-preview-box">{{ previewText }}</pre>
            </div>
          </div>
        </div>
      `,
      setup() {
        const activeTab = ref('routing')
        const showAuthKey = ref(false)
        const showApiConfig = ref(false)
        const showApiToken = ref(false)
        const loadingPeers = ref(false)
        const peerSearch = ref('')

        const previewing = ref(false)
        const previewText = ref('点击右上角“实时预览”或切换至此选项卡以查看生成的配置...')
        const previewError = ref('')

        const form = reactive(loadSettings())
        const peersList = ref(loadCachedPeers())

        const authKeyStatusText = computed(() => maskSecret(form.authKey))

        const onlineCount = computed(() => peersList.value.filter((p) => p.online).length)

        const filteredPeers = computed(() => {
          if (!peerSearch.value.trim()) return peersList.value
          const q = peerSearch.value.trim().toLowerCase()
          return peersList.value.filter(
            (p) =>
              (p.hostname || '').toLowerCase().includes(q) ||
              (p.name || '').toLowerCase().includes(q) ||
              (p.ipv4 || '').includes(q) ||
              (p.subnetRoutes || []).some((r) => r.includes(q))
          )
        })

        const formatLastSeen = (dateStr) => {
          if (!dateStr) return '未知'
          const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
          if (diffSec < 120) return '刚刚在线'
          if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
          if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
          return `${Math.floor(diffSec / 86400)} 天前`
        }

        const fetchDevices = async () => {
          const token = rawText(form.apiToken)
          if (!token) {
            showApiConfig.value = true
            Plugins.message.warn('请先填写 Tailscale API Access Token')
            return
          }

          loadingPeers.value = true
          try {
            const tailnet = encodeURIComponent(rawText(form.tailnetName) || '-')
            const url = `https://api.tailscale.com/api/v2/tailnet/${tailnet}/devices`
            let data

            if (typeof Plugins !== 'undefined' && typeof Plugins.Requests === 'function') {
              const res = await Plugins.Requests({
                method: 'GET',
                url,
                headers: {
                  Authorization: `Bearer ${token}`,
                  'User-Agent': 'GUI.for.SingBox'
                }
              }).catch((err) => {
                throw new Error(`网络连接异常: ${err.message || err}（若在国内请先启动核心以便通过代理访问）`)
              })

              const status = res.status || 200
              const bodyStr = typeof res.body === 'string' ? res.body : JSON.stringify(res.body || {})
              if (status === 401) {
                throw new Error('API Token 无效或已过期，请检查 Token 字符串（格式应为 tskey-api-k...）')
              }
              if (status === 403) {
                throw new Error('API Token 权限不足，请确认在 Tailscale 控制台创建 Token 时勾选了 Devices:Read 权限')
              }
              if (status === 404) {
                throw new Error('未找到该 Tailnet，请检查“Tailnet 组织名称”，或留空填 - 默认使用当前用户网络')
              }
              if (status >= 400) {
                throw new Error(`Tailscale API 报错 (HTTP ${status}): ${bodyStr}`)
              }

              data = typeof res.body === 'object' && res.body !== null ? res.body : JSON.parse(bodyStr)
            } else {
              const res = await fetch(url, {
                headers: {
                  Authorization: `Bearer ${token}`
                }
              }).catch((err) => {
                throw new Error(`浏览器请求失败: ${err.message || err}`)
              })

              if (!res.ok) {
                const errBody = await res.text()
                throw new Error(`API 请求失败 (HTTP ${res.status}): ${errBody || res.statusText}`)
              }
              data = await res.json()
            }

            const rawDevices = Array.isArray(data.devices) ? data.devices : []
            if (!rawDevices.length) {
              Plugins.message.info('未检测到任何同网设备，请确认 Token 关联的 Tailnet 是否有已加入的节点')
            }

            const formatted = rawDevices.map((dev) => {
              const addrs = Array.isArray(dev.addresses) ? dev.addresses : []
              const ipv4 = addrs.find((ip) => ip.includes('.')) || ''
              const ipv6 = addrs.find((ip) => ip.includes(':')) || ''
              const lastSeen = dev.lastSeen
              const diffMs = lastSeen ? Date.now() - new Date(lastSeen).getTime() : Infinity
              const isOnline = diffMs < 12 * 60 * 1000 // 12 分钟内活跃即视为在线

              const advertised = Array.isArray(dev.advertisedRoutes) ? dev.advertisedRoutes : []
              const enabled = Array.isArray(dev.enabledRoutes) ? dev.enabledRoutes : []
              const allRoutes = unique([...advertised, ...enabled])

              const isExitNode =
                dev.exitNode === true ||
                dev.exitNodeOption === true ||
                allRoutes.some((r) => r === '0.0.0.0/0' || r === '::/0')

              const subnetRoutes = allRoutes.filter((r) => r !== '0.0.0.0/0' && r !== '::/0')

              return {
                id: dev.id || dev.nodeKey || ipv4,
                name: dev.name || '',
                hostname: dev.hostname || dev.name?.split('.')[0] || 'Unknown',
                os: dev.os || '',
                ipv4,
                ipv6,
                online: isOnline,
                lastSeenText: formatLastSeen(lastSeen),
                isExitNode,
                subnetRoutes,
                isSelf: dev.hostname === form.hostname
              }
            })

            peersList.value = formatted
            saveCachedPeers(formatted)
            showApiConfig.value = false
            Plugins.message.success(`已同步 ${formatted.length} 台设备信息`)
          } catch (err) {
            Plugins.message.error(err.message || '获取设备列表失败')
          } finally {
            loadingPeers.value = false
          }
        }

        const handleSaveAndFetchApi = async () => {
          saveSettings({ ...form })
          await fetchDevices()
        }

        const handleClearApiToken = () => {
          form.apiToken = ''
          saveSettings({ ...form })
          Plugins.message.info('已清除本地保存的 API Token')
        }

        const setAsExitNode = (dev) => {
          const target = dev.hostname || dev.ipv4
          if (!target) return
          form.exitNode = target
          saveSettings({ ...form })
          Plugins.message.success(`已将出口节点设置为: ${target}，并已保存`)
        }

        const addNodeToRoute = (dev) => {
          const current = csv(form.extraRouteCIDRs, '')
          const toAdd = []

          // 添加设备自身 IPv4 /32
          if (dev.ipv4) toAdd.push(`${dev.ipv4}/32`)
          // 添加设备广播的子网
          if (Array.isArray(dev.subnetRoutes)) {
            toAdd.push(...dev.subnetRoutes)
          }

          const merged = unique([...current, ...toAdd])
          form.extraRouteCIDRs = merged.join(', ')
          saveSettings({ ...form })
          Plugins.message.success(`已将节点网段追加到额外分流路由中: ${toAdd.join(', ')}`)
        }

        const copyText = (val, successMsg = '已复制') => {
          if (!val) return
          if (navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(val).then(() => Plugins.message.success(successMsg))
          } else {
            Plugins.message.info(val)
          }
        }

        const fillDefaultCidrs = () => {
          form.routeCIDRs = DEFAULT_CIDRS
          Plugins.message.info('已填入标准 Tailscale IPv4 与 IPv6 网段')
        }

        const handleSave = () => {
          saveSettings({ ...form })
          Plugins.message.success('Tailscale 插件配置已保存')
        }

        const handleReset = () => {
          const defaults = getDefaultSettings()
          Object.assign(form, defaults)
          Plugins.message.info('已重置为默认配置，请点击保存生效')
        }

        const handlePreview = async () => {
          previewing.value = true
          previewError.value = ''
          try {
            const { currentProfile } = Plugins.useProfilesStore()
            if (!currentProfile) {
              previewError.value = '请先在 GFS 主界面中选择一个活跃的 Profile'
              previewText.value = '// 未检测到当前选中的 Profile'
              return
            }

            const rawConfig = await Plugins.generateConfig(currentProfile)
            const patched = patchConfig(rawConfig, { ...form }, false)

            const previewObj = {
              endpoints: patched.endpoints?.filter((e) => e.type === 'tailscale'),
              dns_servers: patched.dns?.servers?.filter((s) => s.type === 'tailscale'),
              dns_rules: patched.dns?.rules?.filter((r) => r.server === form.dnsTag),
              route_rules: patched.route?.rules?.filter((r) => r.outbound === form.endpointTag)
            }

            previewText.value = JSON.stringify(previewObj, null, 2)
          } catch (err) {
            previewError.value = `生成失败: ${err.message || String(err)}`
            previewText.value = `// 错误详情:\n${err.stack || err.message || String(err)}`
          } finally {
            previewing.value = false
          }
        }

        onMounted(() => {
          if (!peersList.value.length && form.apiToken) {
            fetchDevices()
          }
        })

        return {
          activeTab,
          form,
          showAuthKey,
          showApiConfig,
          showApiToken,
          loadingPeers,
          peerSearch,
          peersList,
          onlineCount,
          filteredPeers,
          fetchDevices,
          handleSaveAndFetchApi,
          handleClearApiToken,
          setAsExitNode,
          addNodeToRoute,
          copyText,
          authKeyStatusText,
          fillDefaultCidrs,
          handleSave,
          handleReset,
          handlePreview,
          previewing,
          previewText,
          previewError
        }
      }
    })

    modal.setContent(component)
    modal.open()
  }

  const onRun = () => openUI()

  const onBeforeCoreStart = (config) => patchConfig(config)

  return {
    onRun,
    onBeforeCoreStart,
    patchConfig
  }
}
