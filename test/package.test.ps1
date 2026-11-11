[CmdletBinding()]
param([string]$ZipPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $ZipPath) { $ZipPath = Join-Path $root 'dist\app.zip' }
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
$temporary = Join-Path ([IO.Path]::GetTempPath()) "document-review-package-test-$([guid]::NewGuid().ToString('N'))"
$process = $null
$saved = @{}
$variables = @('PORT', 'STORAGE_ACCOUNT_URL', 'AUTH_TENANT_ID', 'AUTH_API_CLIENT_ID', 'AUTH_SPA_CLIENT_ID', 'NODE_PATH')
foreach ($key in $variables) { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
try {
    [void](New-Item $temporary -ItemType Directory -Force)
    [IO.Compression.ZipFile]::ExtractToDirectory((Resolve-Path $ZipPath).Path, $temporary)
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $env:PORT = $port
    $env:STORAGE_ACCOUNT_URL = 'https://synthetic.blob.core.windows.net/'
    $env:AUTH_TENANT_ID = '11111111-1111-4111-8111-111111111111'
    Remove-Item Env:\AUTH_API_CLIENT_ID, Env:\AUTH_SPA_CLIENT_ID, Env:\NODE_PATH -ErrorAction SilentlyContinue
    $process = Start-Process (Get-Command node).Source -ArgumentList ('"' + (Join-Path $temporary 'server\index.mjs') + '"') `
        -WorkingDirectory $temporary -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $temporary 'stdout.log') -RedirectStandardError (Join-Path $temporary 'stderr.log')
    $origin = "http://127.0.0.1:$port"
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($process.HasExited) { throw (Get-Content -Raw (Join-Path $temporary 'stderr.log')) }
        try {
            $health = Invoke-RestMethod "$origin/healthz" -TimeoutSec 2
            if ($health.status -eq 'ok' -and $health.component -eq 'document-review') { $ready = $true; break }
        } catch { }
        Start-Sleep 1
    }
    if (-not $ready) { throw 'The packaged production entry point did not become healthy.' }
    $config = Invoke-RestMethod "$origin/api/config"
    if ($config.version -ne $version -or $config.mode -ne 'identity_setup_required' -or $config.apiScope) {
        throw 'The actual packaged runtime did not start in the expected locked identity-setup state.'
    }
    foreach ($route in @('/api/me', '/api/cases', '/api/cases/example/document')) {
        $response = Invoke-WebRequest "$origin$route" -Headers @{ Authorization = 'Bearer not-a-setup-bypass' } -SkipHttpErrorCheck
        if ($response.StatusCode -ne 503 -or ($response.Content | ConvertFrom-Json).error -ne 'identity_setup_required') {
            throw "A packaged API was not locked: $route"
        }
    }
    foreach ($asset in @('/app.mjs', '/vendor/pdfjs/build/pdf.mjs', '/vendor/pdfjs/build/pdf.worker.mjs', '/vendor/msal/msal-browser.min.js', '/vendor/msal/redirect-bridge/msal-redirect-bridge.min.js')) {
        if ((Invoke-WebRequest "$origin$asset").StatusCode -ne 200) { throw "Packaged browser asset missing: $asset" }
    }
    @{ status = 'passed'; version = $version; actualRuntimeZip = (Resolve-Path $ZipPath).Path; setupApisLocked = $true; browserAssets = 5 } | ConvertTo-Json
} finally {
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit() }
    foreach ($key in $variables) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
    if (Test-Path $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
