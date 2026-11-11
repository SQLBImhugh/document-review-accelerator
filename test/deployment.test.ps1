$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $root 'scripts\deploy.ps1'), [ref]$tokens, [ref]$errors)
if ($errors) { throw ($errors | Out-String) }
$resolver = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-Networking'
}, $true)
if (-not $resolver) { throw 'The deployment networking resolver was not found.' }
. ([scriptblock]::Create($resolver.Extent.Text))

foreach ($case in @(
    @{ name = 'new default'; private = $false; frontend = $false; expectedPrivate = $false; expectedPublic = $true },
    @{ name = 'explicit public'; private = $false; frontend = $true; expectedPrivate = $false; expectedPublic = $true },
    @{ name = 'private deployment'; private = $true; frontend = $false; expectedPrivate = $true; expectedPublic = $false },
    @{ name = 'private data, public frontend'; private = $true; frontend = $true; expectedPrivate = $true; expectedPublic = $true }
)) {
    $actual = Resolve-Networking $case.private $case.frontend $null
    if ($actual.privateNetworking -ne $case.expectedPrivate -or $actual.publicFrontend -ne $case.expectedPublic) {
        throw "Wrong topology: $($case.name)"
    }
}
$publicReceipt = [pscustomobject]@{ privateNetworking = $false; publicFrontend = $true }
$privateReceipt = [pscustomobject]@{ privateNetworking = $true; publicFrontend = $false }
$legacyReceipt = [pscustomobject]@{ publicFrontend = $true }
[void](Resolve-Networking $false $false $publicReceipt)
[void](Resolve-Networking $true $false $privateReceipt)
[void](Resolve-Networking $true $true $legacyReceipt)
foreach ($case in @(
    @{ private = $false; frontend = $false; receipt = $legacyReceipt },
    @{ private = $false; frontend = $true; receipt = $privateReceipt },
    @{ private = $true; frontend = $true; receipt = $publicReceipt },
    @{ private = $true; frontend = $true; receipt = $privateReceipt }
)) {
    $rejected = $false
    try { [void](Resolve-Networking $case.private $case.frontend $case.receipt) }
    catch {
        if ($_.Exception.Message -notlike 'The networking mode differs*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'A saved deployment could silently change its networking mode.' }
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) "document-review-deploy-test-$([guid]::NewGuid().ToString('N'))"
try {
    [void](New-Item (Join-Path $fixture 'scripts') -ItemType Directory -Force)
    Copy-Item (Join-Path $root 'scripts\deploy.ps1') (Join-Path $fixture 'scripts\deploy.ps1')
    & {
        function az {
            $global:LASTEXITCODE = 0
            switch ("$($args[0]) $($args[1])") {
                'account set' { return }
                'account show' { return '{"id":"test-subscription","tenantId":"test-tenant","environmentName":"AzureCloud"}' }
                'group exists' { return 'true' }
                'group show' { return '{"tags":{"Workload":"document-review-accelerator"}}' }
                default { throw 'Unexpected Azure call while a deployment receipt is missing.' }
            }
        }
        $rejected = $false
        try {
            & (Join-Path $fixture 'scripts\deploy.ps1') -SubscriptionId 'test-subscription' -TenantId 'test-tenant'
        } catch {
            if ($_.Exception.Message -notlike 'This resource group already exists, but its deployment receipt is missing*') { throw }
            $rejected = $true
        }
        if (-not $rejected) { throw 'An existing group without a receipt could be exposed through the new default.' }
    }
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
Write-Host 'Deployment topology selection and saved-mode protection passed (12 cases; Azure calls mocked).'
