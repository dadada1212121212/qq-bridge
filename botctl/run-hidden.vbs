' 蓝色大肥鱼 · 手机控制台 —— 隐藏窗口启动器
' 由计划任务 BotCtl-Phone 在登录时调用；也可以双击手动拉起。
Option Explicit
Dim sh, nodeExe, script, root
Set sh = CreateObject("WScript.Shell")
nodeExe = "E:\node.exe"
root = "C:\Users\ASUS\.dsh\ungrouped\qq-bridge"
script = root & "\botctl\server.mjs"

If Not CreateObject("Scripting.FileSystemObject").FileExists(nodeExe) Then
  nodeExe = "node.exe"
End If

sh.CurrentDirectory = root
' 0 = 隐藏窗口, False = 不等待
sh.Run """" & nodeExe & """ """ & script & """", 0, False
