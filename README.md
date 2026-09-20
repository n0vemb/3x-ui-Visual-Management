# 3X-UI 面板看板（xui-dashboard）

多服务器 3X-UI / X-UI 面板的**关系可视化看板**：入站 = 大星球 + 一圈客户端小行星，出站 = 拖在星球群里的小尾巴，一个出站可被多个入站绑定（多对一）。

- 前端：纯静态单文件（`public/index.html`），零依赖
- 后端：`server.js`，Node 原生模块，**零依赖**，负责拉取面板数据 + IP 地理位置
- 数据链路：`后端每 20 秒轮询各面板 → 汇总快照 → 前端每 15 秒拉取 /api/data`

## 运行

```bash
cd xui-dashboard
node server.js
# 打开 http://localhost:8787
```

首次启动默认 `demo: true`（演示数据），验证界面没问题后再填真实面板。

## 接入真实面板

**推荐：直接在网页上操作** —— 点标签栏右侧的「＋」打开服务器管理弹窗：

- 添加：填名称、面板地址（含端口/路径）、账密（或新版 3x-ui 的 API Token）→「测试连接」→「保存服务器」
- 编辑 / 删除 / 启停：列表里对应按钮；已保存的密码不回显，留空 = 保持不变
- 演示模式开关：弹窗底部可切换（不再需要手改 config.json）

改动**立即生效**，无需重启。等价的手工方式：编辑 `config.json`：

```json
{
  "port": 8787,
  "demo": false,
  "pollInterval": 20,     ← 后端轮询间隔（秒）
  "dashboardKey": "",     ← 可选：设置后前端访问需输入此密码
  "servers": [
    {
      "id": "us",
      "name": "美国 · 45.119.4.207",
      "url": "https://45.119.4.207:54321",   ← 面板完整地址（含端口/路径）
      "username": "admin",
      "password": "xxx",
      "token": "",          ← 可选：API Token，填了就优先用 token，账密可留空
      "insecure": true,     ← 面板是自签证书时保持 true
      "enabled": true,
      "outbounds": [        ← 可选：手工登记出站（老版本面板靠这个显示 ip:port）
        { "tag": "204.170.138", "ip": "204.170.138:9467", "proto": "socks" }
      ],
      "bindings": {         ← 可选：手工绑定 入站remark/tag → 出站tag（优先级最高）
        "包子": "204.170.138"
      }
    }
  ]
}
```

保存即生效（后端每 5 秒检测配置变更，**无需重启**）。`url` 不完整的服务器会以灰点显示在标签栏，提示配置不完整。

## 数据来源（3x-ui 官方 API）

| 信息 | 接口 | 降级策略 |
|---|---|---|
| 登录 | `POST /login`（会话 Cookie） | 或 Bearer Token |
| 入站+客户端（流量/到期/启停） | `GET /panel/api/inbounds/list` | — |
| 在线客户端 | `GET /panel/api/inbounds/onlines` | 拿不到 → 全部显示离线 |
| 服务器状态（CPU/内存/运行时长/Xray） | `GET /panel/api/server/status` | 老版本 `/server/status` |
| 出站列表 + 入站→出站绑定 | `GET /panel/api/server/getConfigJson`（解析 outbounds + routing.rules，**绑定关系自动推导**） | `GET /panel/api/xray/getOutboundsTraffic`（仅 tag+流量） |
| 出站 IP 地理位置 | `ip-api.com` 批量接口（免费，一次请求查 100 个） | 本地缓存 `geo_cache.json`，默认 7 天过期 |

优先级：手工 `bindings` > Xray 路由规则自动推导 > 无绑定（星球不连线）。
手工 `outbounds` 可补充/覆盖自动发现出站的 ip:port 和启停状态。

## 看板交互

- 顶栏：入站/出站/客户端/在线/耗尽 统计 + 当前服务器 CPU/内存/运行时长
- 标签页：每个服务器一个 tab，圆点 = 服务器状态（绿正常 / 黄有异常 / 红连不上，悬停可看错误原因）
- 星系布局：一个出站尾巴 = 一个星系，自动排布；入站星球围在尾巴周围
- 点击星球 → 展开/收起客户端信息卡（在线状态、已用流量/总量、剩余天数）
- 悬停客户端 → 虚线连所属入站；悬停入站 → 虚线连所有客户端
- 拖动：入站（客户端跟随）、出站尾巴、客户端卡均可拖，位置保存在浏览器 localStorage
- 滚轮缩放 / 空白处拖拽平移 / 「重置视图」/「手动刷新」强制后端立即重新拉取

## 状态判定

- 客户端在线：email 出现在面板在线列表
- 耗尽（红）：已用流量 ≥ 总量（总量>0），或已过到期时间
- 离线（灰）：其余情况
- 无限期：到期时间为 0，显示「无限期」

## 宝塔面板部署

项目零依赖（无 npm install），单文件后端 + 静态前端，部署只需「Node 运行 + 常驻 + 反代」三步。

### 1. 上传项目

把整个 `xui-dashboard/` 目录（`server.js`、`public/`、`config.json`）上传到服务器，例如 `/www/xui-dashboard/`。
注意：`config.json` 里存面板账密，`geo_cache.json` 是地理位置缓存（可不传，会自动生成）。

### 2. 安装 Node 与 PM2

- 软件商店 → 安装「**Node.js 版本管理器**」→ 安装 Node **18 或更高**（v20/v22 均可）
- 软件商店 → 安装「**PM2 管理器**」（或 SSH 里 `npm i -g pm2`）

### 3. 启动并设置开机自启

SSH 里执行：

```bash
# 用宝塔 Node 版本管理器装的 node（路径按实际版本调整）
ln -sf /www/server/nodejs/v22.14.0/bin/node /usr/local/bin/node
ln -sf /www/server/nodejs/v22.14.0/bin/pm2 /usr/local/bin/pm2

cd /www/xui-dashboard
pm2 start server.js --name xui-dashboard
pm2 save          # 保存进程列表
pm2 startup       # 设置开机自启（按提示再执行一条命令）
```

或在 PM2 管理器界面添加项目：启动文件 `server.js`，运行目录 `/www/xui-dashboard`，名称 `xui-dashboard`。

验证：`curl http://127.0.0.1:8787/api/settings` 有 JSON 返回即正常。

### 3b. 方式二：宝塔「Node 项目」可视化添加（推荐）

新版宝塔的「网站 → Node项目 → 添加Node项目」要求项目有 `package.json`（项目里已提供）。填写：

| 字段 | 填写 |
|---|---|
| 项目目录 | 上传的目录，如 `/www/wwwroot/xuiwebui` |
| 项目名称 | `xui-dashboard` |
| 启动选项 | **自定义启动命令** → 输入 `node server.js`（或选 `npm start`） |
| Node版本 | v18 及以上（v22.14.0 可用） |
| 包管理器 | 随意（pnpm/npm 均可），**勾选「不安装node_modules」**（零依赖，装了也白装） |
| 项目端口（更多配置里） | `8787`（与 config.json 的 port 一致，填错会 502） |

**关键一步：目录属主要给 www**，否则网页上的服务器管理弹窗写不进 config.json：

```bash
chown -R www:www /www/wwwroot/xuiwebui
```

宝塔的 Node 项目自带开机自启和进程守护，不需要再装 PM2。添加完成后：
- 直接访问 `http://IP:8787`（需宝塔「安全」+ 云安全组放行 8787），或
- 建网站做反向代理指向 `127.0.0.1:8787`（推荐，可上 SSL，8787 不对外）

### 4. 放行端口或挂反代（二选一）

- **直接暴露**：宝塔「安全」放行 `8787` + 云服务商安全组放行 → 访问 `http://服务器IP:8787`
- **反代（推荐）**：宝塔新建站点（域名）→ 站点设置 →「反向代理」→ 目标 `http://127.0.0.1:8787`；
  再用宝塔「SSL」给站点上证书。这样 8787 无需对外开放，看板走 HTTPS。

反代无需任何特殊配置（前端拉后端是同源请求，WebSocket 未用到）。

### 5. 上线前检查

- `config.json` 设置 **`dashboardKey`**（公网必须）：设置后打开看板需输入访问密码
- 宝塔「安全」里不要放行 8787（走反代时）
- 服务器需能出网访问各面板地址和 ip-api.com；面板是自签证书时，管理弹窗里保持「跳过证书校验」开启

### 常见问题

| 现象 | 处理 |
|---|---|
| pm2: command not found | Node 版本管理器装完要把对应版本的 bin 加到 PATH（软链如上） |
| 看板能开但标签红点 | SSH `curl -v 面板地址/panel/api/server/status` 排查出网/防火墙 |
| 改了 config.json 没生效 | 后端每 5 秒检测配置；确认保存的是服务器上的文件，改完等几秒或点「手动刷新」 |
| 端口被占用 | 改 `config.json` 的 `port`，PM2 `pm2 restart xui-dashboard` |

## 安全提醒

- `dashboardKey` 建议设置（前端会弹出密码框，存 localStorage）
- 如果要看板暴露到公网，务必挂在反向代理后面并加认证
- 面板账密只存在于本机 `config.json`，不会下发给前端；`/api/data` 只返回展示所需的归一化数据

## 已知限制

- 老版本 3x-ui 没有出站列表接口，出站 ip:port 需要 `outbounds` 手工登记（tag 必须和面板出站 tag 一致）
- `onlines` 接口不可用的版本，在线状态全部显示离线
- ip-api 免费版仅 http、限速（批量接口一次 100 个，正常轮询足够）
