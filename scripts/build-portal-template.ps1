$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& az bicep build --file (Join-Path $root 'infra\azuredeploy.bicep') --outfile (Join-Path $root 'infra\azuredeploy.json')
if ($LASTEXITCODE -ne 0) { throw 'Portal template compilation failed.' }
Write-Host 'Generated infra\azuredeploy.json from the current Bicep and package version.'
