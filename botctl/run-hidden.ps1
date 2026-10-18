# 蓝色大肥鱼 · 手机控制台 —— 隐藏窗口启动器（由计划任务 BotCtl-Phone 调用）
# 路径按脚本位置推（本文件在 <repo>\botctl\ 下），不写死本机绝对路径。
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
# node 路径：优先 BOTCTL_NODE，其次 PATH 里的 node.exe
$node = $env:BOTCTL_NODE
if (-not $node) {
  $found = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($found) { $node = $found.Source }
}
if (-not $node) { $node = 'node.exe' }
& $node (Join-Path $root 'botctl\server.mjs')
