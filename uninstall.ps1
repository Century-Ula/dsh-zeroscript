#Requires -Version 5.1
<#
.SYNOPSIS
        从 DeepSeek Harness profile 中卸载 dsh-zeroscript。

.DESCRIPTION
        与 install.ps1 对称：

          1. 从 <profile>\cordis.patch.yml 里删掉 id 为 zeroscript 的条目；
          2. 删除 <profile>\node_modules\dsh-zeroscript junction（只删链接，不动插件目录）。

        删除前会备份 patch 文件。不会删除你的插件目录，也不会动 ZeroScript 本体。

.PARAMETER Profile
        profile 名称，默认 desktop。

.PARAMETER DshHome
        DSH 的 home 目录，默认 %USERPROFILE%\.dsh。

.PARAMETER KeepLink
        保留 node_modules 链接，只删 patch 条目。

.PARAMETER DryRun
        只打印将要做的改动，不写任何文件。

.EXAMPLE
        .\uninstall.ps1
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$KeepLink,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$LinkPath = Join-Path (Join-Path $ProfileDir 'node_modules') 'dsh-zeroscript'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

Write-Say "`nZeroScript for DeepSeek Harness - 卸载程序`n" 'White'
Write-Say "  profile  : $Profile"
Write-Say "  目标目录 : $ProfileDir"

if (-not (Test-Path -LiteralPath $ProfileDir)) {
    Write-Say "`n找不到 profile 目录，无需卸载。" 'Yellow'
    exit 0
}

$changed = $false

# ---------------------------------------------------------------- 1. patch
if (-not (Test-Path -LiteralPath $PatchFile)) {
    Write-Say "`n没有 patch 文件，跳过。" 'Yellow'
} else {
    $text = [System.IO.File]::ReadAllText($PatchFile)
    $lines = @($text -split "\r?\n")

    $blockStart = -1
    $blockIndent = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^(\s*)-\s*insert:\s*$') {
            $indent = $Matches[1].Length
            # 在插入块内找 id: zeroscript
            for ($j = $i + 1; $j -lt $lines.Count; $j++) {
                $line = $lines[$j]
                if ($line.Trim().Length -gt 0) {
                    $lead = ([regex]::Match($line, '^\s*')).Length
                    if ($lead -le $indent) { break }
                }
                if ($line -match '^\s*-\s+id:\s*zeroscript(-[\w-]+)?\s*$') {
                    $blockStart = $i
                    $blockIndent = $indent
                    break
                }
            }
            if ($blockStart -ge 0) { break }
        }
    }

    if ($blockStart -lt 0) {
        Write-Say "`npatch 里没有 zeroscript 条目，跳过。" 'Yellow'
    } else {
        # 插入块的范围
        $blockEnd = $blockStart + 1
        while ($blockEnd -lt $lines.Count) {
            $line = $lines[$blockEnd]
            if ($line.Trim().Length -gt 0) {
                $lead = ([regex]::Match($line, '^\s*')).Length
                if ($lead -le $blockIndent) { break }
            }
            $blockEnd++
        }

        # 块内属于 zeroscript 的这一项范围
        $itemStart = -1
        $itemIndent = 0
        for ($j = $blockStart + 1; $j -lt $blockEnd; $j++) {
            if ($lines[$j] -match '^(\s*)-\s+id:\s*zeroscript(-[\w-]+)?\s*$') {
                $itemStart = $j
                $itemIndent = $Matches[1].Length
                break
            }
        }
        $itemEnd = $itemStart + 1
        while ($itemEnd -lt $blockEnd) {
            $line = $lines[$itemEnd]
            if ($line -match '^(\s*)-\s+\S') {
                if ($Matches[1].Length -eq $itemIndent) { break }
            }
            $itemEnd++
        }

        # 块里还有别的条目就只删这一项，否则整块删除
        $otherItems = $false
        for ($j = $blockStart + 1; $j -lt $blockEnd; $j++) {
            if ($j -ge $itemStart -and $j -lt $itemEnd) { continue }
            if ($lines[$j] -match '^\s*-\s+(id|config|insert):') { $otherItems = $true; break }
        }

        if ($otherItems) {
            $newLines = @()
            for ($j = 0; $j -lt $lines.Count; $j++) {
                if ($j -ge $itemStart -and $j -lt $itemEnd) { continue }
                $newLines += $lines[$j]
            }
            Write-Say "`n将只删除 id: zeroscript 这一项（该 insert 块还有其它条目）" 'Cyan'
        } else {
            $newLines = @()
            for ($j = 0; $j -lt $lines.Count; $j++) {
                if ($j -ge $blockStart -and $j -lt $blockEnd) { continue }
                $newLines += $lines[$j]
            }
            Write-Say "`n将删除整个 zeroscript insert 块" 'Cyan'
        }

        # DSH 不接受「只剩注释」的 patch 文件：补一个 []
        $hasEntry = $false
        foreach ($line in $newLines) {
            $t = $line.Trim()
            if ($t.Length -gt 0 -and -not $t.StartsWith('#') -and $t -ne '[]') { $hasEntry = $true; break }
        }
        if (-not $hasEntry) { $newLines = @('[]') }

        $newText = ($newLines -join "`r`n")
        if (-not $newText.EndsWith("`n")) { $newText += "`r`n" }

        if ($DryRun) {
            Write-Say "`n[DryRun] 以下内容将写入 $PatchFile`n" 'Yellow'
            Write-Host $newText
        } else {
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
            $backup = "$PatchFile.bak-$stamp"
            while (Test-Path -LiteralPath $backup) { $backup = "$PatchFile.bak-$stamp-" + [Guid]::NewGuid().ToString('N').Substring(0, 4) }
            Copy-Item -LiteralPath $PatchFile -Destination $backup -Force
            Write-Say "  已备份原文件 -> $backup" 'Green'
            [System.IO.File]::WriteAllText($PatchFile, $newText, $Utf8NoBom)
            Write-Say "  已写回 $PatchFile" 'Green'
            $changed = $true
        }
    }
}

# ---------------------------------------------------------------- 2. junction
if ($KeepLink) {
    Write-Say "`n保留 node_modules 链接（-KeepLink）。" 'Gray'
} elseif (Test-Path -LiteralPath $LinkPath) {
    $item = Get-Item -LiteralPath $LinkPath -Force
    $target = $null
    if ($item.LinkType -eq 'Junction' -and $item.Target) { $target = @($item.Target)[0] }
    $resolved = $target
    if ($target) { try { $resolved = (Resolve-Path -LiteralPath $target).Path } catch { } }
    if ($resolved -eq $PluginDir) {
        if ($DryRun) {
            Write-Say "`n[DryRun] 将删除 junction $LinkPath" 'Cyan'
        } else {
            # 只删除 junction 本身。不要用 Remove-Item -Recurse（会跟进去删目标内容），
            # Directory.Delete(recursive: false) 对 junction 只删重解析点。
            try {
                [System.IO.Directory]::Delete($LinkPath, $false)
            } catch {
                Write-Say "`n  删除 junction 失败：$($_.Exception.Message)" 'Red'
                Write-Say "  请手动删除该链接：$LinkPath" 'Yellow'
                exit 1
            }
            if (Test-Path -LiteralPath $LinkPath) {
                Write-Say "`n  junction 仍然存在，请手动删除：$LinkPath" 'Yellow'
                exit 1
            }
            Write-Say "`n  已删除 junction $LinkPath" 'Green'
            $changed = $true
        }
    } else {
        Write-Say "`n链接 $LinkPath 指向别的目录（$target），保留不动。" 'Yellow'
    }
}

if ($changed) {
    Write-Say "`n完成。重启 DeepSeek Harness 后插件即不再加载。`n" 'White'
} else {
    Write-Say "`n没有需要改动的内容。`n" 'White'
}
