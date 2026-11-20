Option Explicit

Dim fso, shell, projectRoot, electronPath, prototypeData, legacyData, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
electronPath = fso.BuildPath(projectRoot, "node_modules\electron\dist\electron.exe")
If Not fso.FileExists(electronPath) Then
  MsgBox "Prototype dependencies are missing. Run npm install in the Perflw project folder.", vbExclamation, "Perflw Prototype"
  WScript.Quit 1
End If

prototypeData = fso.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "Perflw Prototype")
' Before the rename to Perflw the prototype data lived in "Impct Intelligence Prototype".
' On the first launch it is copied once; the original folder is left untouched.
legacyData = fso.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "Impct Intelligence Prototype")
If Not fso.FolderExists(prototypeData) And fso.FolderExists(legacyData) Then fso.CopyFolder legacyData, prototypeData
If Not fso.FolderExists(prototypeData) Then fso.CreateFolder prototypeData
shell.Environment("Process")("PERFLW_TEST_USER_DATA") = prototypeData
shell.CurrentDirectory = projectRoot
command = Chr(34) & electronPath & Chr(34) & " ."
shell.Run command, 1, False
