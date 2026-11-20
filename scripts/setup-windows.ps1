$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$folder = Get-Item -LiteralPath $project
$ini = Get-Item -LiteralPath (Join-Path $project 'desktop.ini') -Force
$folder.Attributes = $folder.Attributes -bor [System.IO.FileAttributes]::ReadOnly
$ini.Attributes = $ini.Attributes -bor [System.IO.FileAttributes]::Hidden -bor [System.IO.FileAttributes]::System

$exe = Join-Path $project 'dist\Perflw-win32-x64\Perflw.exe'
$exe = (Resolve-Path -LiteralPath $exe -ErrorAction Stop).Path
$icon = (Resolve-Path -LiteralPath (Join-Path $project 'assets\icon.ico') -ErrorAction Stop).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPaths = @(
    [pscustomobject]@{ Path = (Join-Path $desktop 'Perflw.lnk'); Required = $true },
    [pscustomobject]@{ Path = (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Perflw.lnk'); Required = $false },
    [pscustomobject]@{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Perflw.lnk'); Required = $false }
)

$shell = New-Object -ComObject WScript.Shell
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PerflwShellRefresh {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern void SHChangeNotify(int eventId, int flags, string item1, IntPtr item2);
}
'@
foreach ($item in $shortcutPaths) {
    if (-not $item.Required -and -not (Test-Path -LiteralPath $item.Path)) { continue }
    $shortcut = $shell.CreateShortcut($item.Path)
    if (-not $item.Required -and $shortcut.TargetPath -ne $exe) { continue }
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = Split-Path -Parent $exe
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = 'Open Perflw'
    $shortcut.Save()
    [PerflwShellRefresh]::SHChangeNotify(0x2000, 0x5, $item.Path, [IntPtr]::Zero)
    Write-Output "Updated shortcut icon: $($item.Path)"
}

# Shortcuts from before the rename to Perflw are removed, but only when they point at this project's old build.
$legacyExe = Join-Path $project 'dist\Impct Intelligence-win32-x64\Impct Intelligence.exe'
$legacyPaths = @(
    (Join-Path $desktop 'Impct Intelligence.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Impct Intelligence.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'Impct Intelligence.lnk')
)
foreach ($path in $legacyPaths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    if ($shell.CreateShortcut($path).TargetPath -ne $legacyExe) { continue }
    Remove-Item -LiteralPath $path
    [PerflwShellRefresh]::SHChangeNotify(0x2000, 0x5, $path, [IntPtr]::Zero)
    Write-Output "Removed old shortcut: $path"
}

Write-Output 'Set project folder icon and refreshed Perflw shortcuts'
