#Requires -Version 5.1
<#
.SYNOPSIS
        把 dsh-zeroscript 安装进一个 DeepSeek Harness profile。

.DESCRIPTION
        做两件事，都是 DSH 官方支持的第三方插件接法：

          1. 把本目录以 junction 链接到 <profile>\node_modules\dsh-zeroscript
             （GUI 侧边栏面板靠它进入客户端模块图）；
          2. 在 <profile>\cordis.patch.yml 里插入/更新一条 loader 条目，
             让宿主加载 lib/index.js。

        脚本是幂等的：重复运行只会把条目的缓存串 ?m=N 递增（用于热重载），
        不会重复插入，也不会改动你已有的 config（Open Cloud key 等）。

.PARAMETER Profile
        profile 名称，默认 desktop。

.PARAMETER DshHome
        DSH 的 home 目录，默认 %USERPROFILE%\.dsh。

.PARAMETER SkipLink
        只改 patch 文件，不创建 node_modules 链接（手动接客户端面板时才需要）。

.PARAMETER DryRun
        只打印将要做的改动，不写任何文件。

.EXAMPLE
        .\install.ps1

.EXAMPLE
        .\install.ps1 -Profile desktop -DryRun
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$SkipLink,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$ProfileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$LinkPath = Join-Path (Join-Path $ProfileDir 'node_modules') 'dsh-zeroscript'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($text) { Write-Host "  * $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "    ! $text" -ForegroundColor Yellow }
function Fail($text) {
    Write-Host "`n安装失败：$text" -ForegroundColor Red
    exit 1
}

function Read-Text($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return [System.IO.File]::ReadAllText($path)
}

function Write-Text($path, $text) {
    $parent = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}

function New-EntryBlock($url) {
    # 注意：PowerShell 5.1 在 @() 数组字面量里不会正确求值 `字符串 + 变量` 这种拼接，
    # 会把它拆成多个数组元素 —— 所以这里逐段用 + 拼接后再返回。
    $nl = "`r`n"
    return '- insert:' + $nl +
        '    - id: zeroscript' + $nl +
        '      name: "' + $url + '"' + $nl
}

function Get-Url($bump) {
    $slashPath = $PluginDir -replace '\\', '/'
    $m = 1
    if ($bump -and ($bump -match '\d+')) { $m = [int]$bump + 1 }
    return "file:///$slashPath/lib/index.js?m=$m"
}

Write-Host "`nZeroScript for DeepSeek Harness - 安装程序`n" -ForegroundColor White
Write-Host "  插件目录 : $PluginDir"
Write-Host "  DSH home : $DshHome"
Write-Host "  profile  : $Profile"
Write-Host "  目标目录 : $ProfileDir`n"

# ---------------------------------------------------------------- preflight
if ($env:OS -ne 'Windows_NT') {
    Fail '本插件的无窗口自动启动依赖 Windows（wscript / bridge.py），目前仅支持 Windows。'
}
if (-not (Test-Path -LiteralPath $ProfileDir)) {
    Fail "找不到 profile 目录：$ProfileDir`n请确认 DSH 已至少启动过一次，或用 -Profile 指定正确的 profile 名。"
}
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'lib\index.js'))) {
    Fail "插件目录里没有 lib\index.js：$PluginDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'lib\client.js'))) {
    Write-Warn '没有找到 lib\client.js，GUI 侧边栏面板将不可用（控制台网页不受影响）。'
}

# ---------------------------------------------------------------- 1. junction
if ($SkipLink) {
    Write-Step '跳过 node_modules 链接（-SkipLink）'
} else {
    Write-Step "链接 $LinkPath"
    $linkTarget = $null
    if (Test-Path -LiteralPath $LinkPath) {
        $item = Get-Item -LiteralPath $LinkPath -Force
        if ($item.LinkType -eq 'Junction' -and $item.Target) {
            $linkTarget = @($item.Target)[0]
        }
    }
    if ($linkTarget) {
        $resolved = $linkTarget
        try { $resolved = (Resolve-Path -LiteralPath $linkTarget).Path } catch { }
        if ($resolved -eq $PluginDir) {
            Write-Ok '已存在且指向本目录，无需改动'
        } else {
            Write-Warn "已存在，但指向 $linkTarget；保留不动。若要换成本目录，请先删除该 junction 再运行。"
        }
    } else {
        if ($DryRun) {
            Write-Ok "[DryRun] 将创建 junction -> $PluginDir"
        } else {
            $parent = Split-Path -Parent $LinkPath
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            New-Item -ItemType Junction -Path $LinkPath -Target $PluginDir | Out-Null
            Write-Ok "已创建 junction -> $PluginDir"
        }
    }
}

# ---------------------------------------------------------------- 2. patch
Write-Step "更新 $PatchFile"
$text = Read-Text $PatchFile
if ($null -eq $text) {
    Write-Ok 'patch 文件不存在，将新建'
    $text = ''
}

$lines = @()
if ($text.Trim().Length -gt 0) { $lines = @($text -split "\r?\n") }
$lines = @($lines | Where-Object { $_ -ne '' } | ForEach-Object { $_ })
# 纯注释 / 空数组的 patch 文件按「空」处理（[] 不能和插入项共存）。
$onlyPlaceholder = ($lines.Count -eq 0) -or (($lines | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') -and $_.Trim() -ne '[]' }).Count -eq 0)

$entryIndex = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*-\s+id:\s*zeroscript(-[\w-]+)?\s*$') { $entryIndex = $i; break }
}

$newText = $null
if ($onlyPlaceholder) {
    $block = New-EntryBlock (Get-Url 0)
    $header = @(
        '# Your patch layer for this dsh profile, applied after every bundle layer:',
        '# a top-level YAML array of loader patch entries (id-targeted config',
        '# overrides, disables, and insert lists; `!!js` expressions allowed).',
        '#'
    ) -join "`r`n"
    if ($text.Trim().Length -gt 0) {
        $newText = $header + "`r`n" + $block
    } else {
        $newText = $header + "`r`n" + $block
    }
    Write-Ok '将追加 zeroscript 条目'
} elseif ($entryIndex -ge 0) {
    # 已有条目：只更新它的 name 行（递增缓存串 + 修正路径），其余配置原样保留。
    $nameIndex = -1
    for ($j = $entryIndex + 1; $j -lt [Math]::Min($lines.Count, $entryIndex + 8); $j++) {
        if ($lines[$j] -match '^\s*-\s+id:') { break }
        if ($lines[$j] -match '^\s*name:\s*"(.*)"\s*$') { $nameIndex = $j; break }
    }
    if ($nameIndex -lt 0) {
        Fail "在 $PatchFile 里找到 id: zeroscript，但没找到它的 name 行，无法安全更新。请手动编辑该条目。"
    }
    $oldUrl = $Matches[1]
    $bump = if ($oldUrl -match '\?m=(\d+)') { $Matches[1] } else { '1' }
    $newUrl = Get-Url $bump
    $lines[$nameIndex] = '      name: "' + $newUrl + '"'
    $newText = ($lines -join "`r`n") + "`r`n"
    Write-Ok "已存在（缓存串 -> ?m=$([int]$bump + 1)）"
} else {
    $block = New-EntryBlock (Get-Url 0)
    $newText = ($lines -join "`r`n") + "`r`n" + $block
    Write-Ok '将追加 zeroscript 条目'
}

if ($DryRun) {
    Write-Host "`n[DryRun] 以下内容将写入 $PatchFile`n" -ForegroundColor Yellow
    Write-Host $newText
} else {
    if (Test-Path -LiteralPath $PatchFile) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $backup = "$PatchFile.bak-$stamp"
        while (Test-Path -LiteralPath $backup) { $backup = "$PatchFile.bak-$stamp-" + [Guid]::NewGuid().ToString('N').Substring(0, 4) }
        Copy-Item -LiteralPath $PatchFile -Destination $backup -Force
        Write-Ok "已备份原文件 -> $backup"
    }
    Write-Text $PatchFile $newText
    Write-Ok 'patch 已写入'
}

# ---------------------------------------------------------------- 3. bridge prep
Write-Step '检查 ZeroScript bridge.py'
$candidates = @(
    (Join-Path $PluginDir '..\zeroscript'),
    (Join-Path $env:USERPROFILE 'Downloads'),
    'D:\下载\文件'
)
$foundBridge = $null
foreach ($dir in $candidates) {
    if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
    foreach ($child in Get-ChildItem -LiteralPath $dir -Directory -ErrorAction SilentlyContinue) {
        if ($child.Name -notmatch '^ZeroScript') { continue }
        $py = Join-Path $child.FullName 'bridge.py'
        if (Test-Path -LiteralPath $py) { $foundBridge = $py; break }
    }
    if ($foundBridge) { break }
}
if ($foundBridge) {
    Write-Ok "找到 bridge.py：$foundBridge"
} else {
    Write-Warn '没有自动找到 ZeroScript-Free 的 bridge.py。'
    Write-Warn '请先从 https://github.com/sebattfg/ZeroScript-Free/releases 下载并解压，'
    Write-Warn '或用 patch 条目里的 bridgeDir 指定目录（插件会自动挑选版本最新的那份）。'
}

# ---------------------------------------------------------------- 4. next steps
$consoleUrl = 'http://127.0.0.1:19387/zeroscript'
Write-Host "`n完成。接下来：" -ForegroundColor White
Write-Host "  1. 重启 DeepSeek Harness（loader 只在启动时装载插件；重启后无需再手动开任何窗口）"
Write-Host "  2. 打开 DSH 页面并按 F5 刷新，左侧栏会出现 ZeroScript 图标"
Write-Host "  3. 控制台网页：$consoleUrl"
Write-Host "  4. 自检：$consoleUrl-version   （应返回 JSON）"
Write-Host "`n提示：本插件的 Bridge 由 DSH 进程后台以隐藏窗口方式拉起；"
Write-Host "      关掉 DSH 不会中断它，重新打开 DSH 也不会重复启动它。`n"
