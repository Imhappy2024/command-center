' Start Command Center with no console window.
'
' The shortcut points here rather than at the .cmd. WScript.Shell.Run with a
' window style of 0 starts the process hidden and, crucially, does not flash a
' window first the way `powershell -WindowStyle Hidden` does -- the flash is
' brief but it is exactly the thing that stops it feeling like an app.
'
' Nothing is printed anywhere after this, so the launcher logs to logs\ and
' raises a message box if it cannot start. Run "Command Center.cmd" instead to
' watch it in a console.

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & here & "\command-center.ps1"""
shell.Run cmd, 0, False
