[CmdletBinding()]
param([switch]$Source)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'
[void](New-Item $dist -ItemType Directory -Force)
$name = if ($Source) { 'document-review-accelerator-source.zip' } else { 'app.zip' }
$target = Join-Path $dist $name
$roots = if ($Source) {
    @('server', 'public', 'scripts', 'infra', 'test', 'docs', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'package.json', 'package-lock.json', 'playwright.config.mjs', '.gitignore', '.env.example')
} else {
    @('server', 'public', 'node_modules', 'package.json', 'package-lock.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt')
}
$archive = [System.IO.Compression.ZipArchive]::new(
    [System.IO.File]::Open($target, [System.IO.FileMode]::Create),
    [System.IO.Compression.ZipArchiveMode]::Create, $false)
$count = 0
try {
    foreach ($entry in $roots) {
        $item = Get-Item -LiteralPath (Join-Path $root $entry) -Force
        $files = if ($item.PSIsContainer) { Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force } else { @($item) }
        foreach ($file in $files) {
            $relative = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $count++
        }
    }
} finally { $archive.Dispose() }
@{ file = $target; files = $count; bytes = (Get-Item $target).Length; sourceOnly = [bool]$Source } | ConvertTo-Json
