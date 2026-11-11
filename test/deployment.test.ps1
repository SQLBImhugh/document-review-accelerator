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
    foreach ($fault in @('app-owner', 'tenant', 'storage-url', 'storage-owner')) {
        & {
            function az {
                $global:LASTEXITCODE = 0
                switch ("$($args[0]) $($args[1])") {
                    'account set' { return }
                    'account show' { return '{"id":"test-subscription","tenantId":"test-tenant","environmentName":"AzureCloud"}' }
                    'group exists' { return 'true' }
                    'group show' { return '{"tags":{"Workload":"document-review-accelerator"}}' }
                    'webapp show' {
                        $workload = if ($fault -eq 'app-owner') { 'another-app' } else { 'document-review-accelerator' }
                        return (@{ name = 'docreview-test'; tags = @{ Workload = $workload; DeploymentPrefix = 'docreview' } } | ConvertTo-Json)
                    }
                    'webapp config' {
                        $tenant = if ($fault -eq 'tenant') { 'wrong-tenant' } else { 'test-tenant' }
                        $url = if ($fault -eq 'storage-url') { 'https://not-azure.example/' } else { 'https://demo.blob.core.windows.net/' }
                        return (@(@{ name = 'AUTH_TENANT_ID'; value = $tenant }, @{ name = 'STORAGE_ACCOUNT_URL'; value = $url }) | ConvertTo-Json)
                    }
                    'storage account' { return '{"tags":{"Workload":"another-app"}}' }
                    default { throw 'Identity setup reached a write or Graph call before validating the existing deployment.' }
                }
            }
            $rejected = $false
            try {
                & (Join-Path $fixture 'scripts\deploy.ps1') -SubscriptionId 'test-subscription' -TenantId 'test-tenant' -AppName 'docreview-test' -IdentityOnly
            } catch {
                $expected = switch ($fault) {
                    'app-owner' { 'The target web app does not have the expected accelerator ownership*' }
                    'tenant' { 'The existing app belongs to another configured Entra tenant*' }
                    'storage-url' { 'The app storage endpoint is not an expected Azure Blob account*' }
                    'storage-owner' { 'The app storage account is not owned by this accelerator deployment*' }
                }
                if ($_.Exception.Message -notlike $expected) { throw }
                $rejected = $true
            }
            if (-not $rejected) { throw "Identity setup accepted an unsafe target: $fault" }
        }
    }
    & {
        $state = @{ configProbes = 0; slept = 0; settings = @(); graphPatches = 0 }
        function az {
            $global:LASTEXITCODE = 0
            switch ("$($args[0]) $($args[1])") {
                'account set' { return }
                'account show' { return '{"id":"test-subscription","tenantId":"test-tenant","environmentName":"AzureCloud"}' }
                'group exists' { return 'true' }
                'group show' { return '{"tags":{"Workload":"document-review-accelerator"}}' }
                'webapp show' { return '{"name":"docreview-test","location":"centralus","defaultHostName":"docreview-test.azurewebsites.net","publicNetworkAccess":"Enabled","tags":{"Workload":"document-review-accelerator","DeploymentPrefix":"docreview"}}' }
                'webapp config' {
                    if ($args[3] -eq 'list') {
                        return '[{"name":"AUTH_TENANT_ID","value":"test-tenant"},{"name":"STORAGE_ACCOUNT_URL","value":"https://demo.blob.core.windows.net/"}]'
                    }
                    if ($args[3] -ne 'set') { throw 'Unexpected app configuration operation.' }
                    $state.settings = @($args | Where-Object { $_ -like 'AUTH_*' })
                    return '[]'
                }
                'storage account' { return '{"name":"demo","tags":{"Workload":"document-review-accelerator"}}' }
                'ad signed-in-user' { return '{"id":"operator-object"}' }
                'rest --method' {
                    $method = $args[2]
                    $url = $args[4]
                    if ($method -eq 'PATCH') { $state.graphPatches++; return '{}' }
                    if ($method -ne 'GET') { throw 'Unexpected Graph creation in the existing-registration fixture.' }
                    if ($url.Contains('/applications?')) {
                        $api = $url -like '*-api*'
                        $id = if ($api) { 'api-object' } else { 'spa-object' }
                        $client = if ($api) { '22222222-2222-4222-8222-222222222222' } else { '33333333-3333-4333-8333-333333333333' }
                        return (@{ value = @(@{ id = $id; appId = $client; tags = @('document-review-accelerator:rg-document-review-poc') }) } | ConvertTo-Json -Depth 5)
                    }
                    if ($url.Contains('/servicePrincipals?')) {
                        $id = if ($url -like '*22222222*') { 'api-sp' } else { 'spa-sp' }
                        return (@{ value = @(@{ id = $id }) } | ConvertTo-Json)
                    }
                    if ($url -like '*/appRoleAssignedTo') {
                        return '{"value":[{"principalId":"operator-object","appRoleId":"eebcbd7d-2b89-47d8-a09c-bf4f479eb0ea"},{"principalId":"operator-object","appRoleId":"757f5768-340d-4c8d-b8bf-33580f875e8a"}]}'
                    }
                    throw 'Unexpected Graph operation.'
                }
                default { throw 'Identity-only setup attempted to provision or republish resources.' }
            }
        }
        function npm { throw 'Identity-only setup must not require Node dependencies without -Seed.' }
        function Start-Sleep { param([int]$Seconds) $state.slept += $Seconds }
        function Invoke-RestMethod {
            param([string]$Uri, [int]$TimeoutSec)
            if ($Uri.EndsWith('/healthz')) { return @{ status = 'ok'; component = 'document-review' } }
            if (-not $Uri.EndsWith('/api/config')) { throw 'Unexpected readiness request.' }
            $state.configProbes++
            if ($state.configProbes -eq 1) { return @{ mode = 'identity_setup_required' } }
            @{ mode = 'connected'; spaClientId = '33333333-3333-4333-8333-333333333333'; apiScope = 'api://22222222-2222-4222-8222-222222222222/Review.Access' }
        }
        & (Join-Path $fixture 'scripts\deploy.ps1') -SubscriptionId 'test-subscription' -TenantId 'test-tenant' -AppName 'docreview-test' -IdentityOnly
        $receipt = Get-Content -Raw (Join-Path $fixture '.local\deployment.json') | ConvertFrom-Json
        if ($receipt.appName -ne 'docreview-test' -or $receipt.storageName -ne 'demo' -or
            $receipt.privateNetworking -ne $false -or $receipt.publicFrontend -ne $true -or
            $state.settings.Count -ne 3 -or $state.graphPatches -ne 5 -or $state.slept -ne 5 -or $state.configProbes -ne 2) {
            throw 'Identity-only setup did not preserve the target, complete identity configuration, and wait for the configured worker.'
        }
    }
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
Write-Host 'Deployment topology and identity setup passed (17 cases; Azure calls mocked).'
