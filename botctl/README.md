# 手机控制台（botctl）

在手机上随时 **启动 / 关闭** QQ 聊天机器人「蓝色大肥鱼」。

## 怎么用

手机连上**和电脑同一个 WiFi**，浏览器打开：

```
http://<电脑的局域网IP>:3111/?t=<令牌>
```

- 令牌在 `botctl/token.txt`
- 电脑 IP 用 `ipconfig` 看（形如 `192.168.x.x`，取本机连校园网那块网卡）
- 服务启动时会把所有可用地址写进 `botctl/botctl.log`
- 建议在手机浏览器里「添加到主屏幕」，以后点一下就开

页面上有：

| 元素 | 作用 |
|---|---|
| 运行中 / 已关闭 | 当前状态，每 3 秒自动刷新 |
| 启动 | 启用 5 个看门狗任务 → 拉起桥接 :3100 → 确保 WSL 里 QQ 在线（约 15 秒） |
| 关闭 | 暂停 5 个看门狗任务 → 杀掉桥接（**不动 WSL 里的 QQ**，所以不会掉登录，约 10 秒） |
| 切换群聊模式 | 静默（只回主人私聊）⇄ 正常（群里也会说话） |

## 它是怎么活下来的

- 计划任务 **`BotCtl-Phone`**：登录时自动启动（隐藏窗口，无控制台窗口）
- 服务自己会「无窗口重生」：任务拉起带窗口的那份后立刻退出，由无窗口子进程接管
- 关掉机器人**不会**关掉这个控制台——不然手机就再也叫不醒她了

## 常用命令

```powershell
# 看状态
Get-ScheduledTask -TaskName BotCtl-Phone | Select TaskName,State

# 重启控制台
$p = (Get-NetTCPConnection -LocalPort 3111 -State Listen).OwningProcess
Stop-Process -Id $p -Force
Start-ScheduledTask -TaskName BotCtl-Phone

# 换令牌（改完重启控制台）
# 删掉 botctl/token.txt，重启后会重新生成
```

## 排错

| 症状 | 先看哪 |
|---|---|
| 手机打不开 | 是否同一 WiFi；`botctl/botctl.log` 里的地址；Windows 防火墙是否放行 `E:\node.exe` |
| 页面 401 | 地址漏了 `?t=令牌` |
| 点启动没反应 | 页面下方「执行输出」里 `bot-start.ps1` 的报错 |
| 启动后群里不说话 | 群聊模式是「静默」，点「解除静默」 |
| 端口 3111 被占 | 可能已有一份在跑，看 `botctl/botctl.log` |

## 文件

| 文件 | 作用 |
|---|---|
| `server.mjs` | 控制台本体（零依赖 Node） |
| `token.txt` | 访问令牌（首次启动自动生成） |
| `botctl.log` | 运行日志 + 手机访问地址 |
| `run-hidden.ps1` / `run-hidden.vbs` | 手动启动用（计划任务里直接调 node，不经过它们） |
