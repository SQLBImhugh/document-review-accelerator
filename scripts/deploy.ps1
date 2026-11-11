[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [Parameter(Mandatory)][string]$TenantId,
    [string]$ResourceGroup = 'rg-document-review-poc',
    [string]$NamePrefix = 'docreview',
    [string]$Location = 'centralus',
    [string]$CostCenter = 'POC',
    [string]$Environment = 'POC',
    [string]$DataClassification = 'Synthetic',
    [string]$AppName,
    [switch]$IdentityOnly,
    [switch]$PrivateNetworking,
    [switch]$PublicFrontend,
    [switch]$KeepDemoRunning,
    [switch]$Seed
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
function Invoke-AzJson([string[]]$Arguments) {
    $result = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' ')" }
    if ($result) { ($result -join "`n") | ConvertFrom-Json -Depth 100 }
}
function Assert-Tenant {
    & az account set --subscription $SubscriptionId --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Subscription selection failed.' }
    $account = Invoke-AzJson @('account', 'show')
    if ($account.tenantId -ne $TenantId -or $account.id -ne $SubscriptionId) { throw 'Subscription/tenant mismatch. No changes were made in this sequence.' }
    if ($account.environmentName -ne 'AzureCloud') { throw 'This POC currently supports Azure commercial cloud only.' }
}
function Graph([string]$Method, [string]$Path, $Body = $null) {
    $arguments = @('rest', '--method', $Method, '--url', "https://graph.microsoft.com/v1.0/$Path")
    if ($null -eq $Body) { return Invoke-AzJson $arguments }
    $bodyPath = Join-Path $local 'graph-request.json'
    $Body | ConvertTo-Json -Depth 30 -Compress | Set-Content $bodyPath -Encoding utf8
    try { Invoke-AzJson ($arguments + @('--headers', 'Content-Type=application/json', '--body', "@$bodyPath")) }
    finally { Remove-Item -LiteralPath $bodyPath -ErrorAction SilentlyContinue }
}
function Ensure-App([string]$Name) {
    $found = Graph 'GET' "applications?`$filter=displayName eq '$Name'"
    if ($found.value.Count -gt 1) { throw "Multiple applications match $Name. Resolve the ambiguity before deployment." }
    if ($found.value.Count -eq 1) {
        if ($found.value[0].tags -notcontains "document-review-accelerator:$ResourceGroup") { throw "The existing application $Name is not owned by this deployment." }
        return $found.value[0]
    }
    Graph 'POST' 'applications' @{ displayName = $Name; signInAudience = 'AzureADMyOrg'; tags = @("document-review-accelerator:$ResourceGroup") }
}
function Ensure-SP([string]$AppId) {
    $found = Graph 'GET' "servicePrincipals?`$filter=appId eq '$AppId'"
    if ($found.value.Count) { return $found.value[0] }
    Graph 'POST' 'servicePrincipals' @{ appId = $AppId }
}
function Resolve-Networking([bool]$PrivateNetworking, [bool]$PublicFrontend, $Previous) {
    $frontend = -not $PrivateNetworking -or $PublicFrontend
    if ($null -ne $Previous) {
        $previousPrivate = if ($Previous.PSObject.Properties.Name -contains 'privateNetworking') {
            [bool]$Previous.privateNetworking
        } else { $true }
        if ($previousPrivate -ne $PrivateNetworking -or
            ($Previous.PSObject.Properties.Name -contains 'publicFrontend' -and [bool]$Previous.publicFrontend -ne $frontend)) {
            throw 'The networking mode differs from the saved deployment. Reuse its original -PrivateNetworking/-PublicFrontend options, or use a fresh resource group and checkout for a different mode.'
        }
    }
    @{ privateNetworking = $PrivateNetworking; publicFrontend = $frontend }
}
if ($NamePrefix -notmatch '^[a-z][a-z0-9-]{2,29}$' -or $ResourceGroup -notmatch '^[a-zA-Z0-9._()-]{1,90}$') { throw 'Use a lowercase deployment prefix (3-30 characters) and a valid resource group name.' }
if ($IdentityOnly -and ($AppName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]{1,58}[a-zA-Z0-9]$' -or $PrivateNetworking -or $PublicFrontend)) {
    throw 'Identity-only setup requires the portal AppName output and does not accept networking switches.'
}
if ($AppName -and -not $IdentityOnly) { throw 'AppName is only used with -IdentityOnly. Full deployment uses NamePrefix.' }
$local = Join-Path $root '.local'
$receiptPath = Join-Path $local 'deployment.json'
$previous = $null
if (Test-Path $receiptPath) {
    $previous = Get-Content -Raw $receiptPath | ConvertFrom-Json
    if ($previous.tenantId -ne $TenantId -or $previous.subscriptionId -ne $SubscriptionId -or $previous.resourceGroup -ne $ResourceGroup -or
        (-not $IdentityOnly -and $previous.namePrefix -ne $NamePrefix)) { throw 'This checkout has a receipt for another deployment. Use a separate checkout.' }
}
$networking = if ($IdentityOnly) { $null } else { Resolve-Networking ([bool]$PrivateNetworking) ([bool]$PublicFrontend) $previous }
Assert-Tenant
$groupExists = Invoke-AzJson @('group', 'exists', '--name', $ResourceGroup)
if ($IdentityOnly -and -not $groupExists) { throw 'Identity-only setup requires an existing portal deployment.' }
if ($groupExists) {
    $existingGroup = Invoke-AzJson @('group', 'show', '--name', $ResourceGroup)
    if ($existingGroup.tags.Workload -ne 'document-review-accelerator') { throw 'Refusing to adopt a resource group without this accelerator ownership tag.' }
    if (-not $IdentityOnly -and $null -eq $previous) { throw 'This resource group already exists, but its deployment receipt is missing. Restore the original ignored receipt before updating it, or use a fresh resource group.' }
}
if ($IdentityOnly) {
    $existingApp = Invoke-AzJson @('webapp', 'show', '--resource-group', $ResourceGroup, '--name', $AppName)
    if ($existingApp.name -ne $AppName -or $existingApp.tags.Workload -ne 'document-review-accelerator' -or
        $existingApp.tags.DeploymentPrefix -notmatch '^[a-z][a-z0-9-]{2,29}$') {
        throw 'The target web app does not have the expected accelerator ownership and deployment-prefix tags.'
    }
    $NamePrefix = $existingApp.tags.DeploymentPrefix
    if ($previous -and ($previous.namePrefix -ne $NamePrefix -or ($previous.appName -and $previous.appName -ne $AppName))) {
        throw 'The selected app does not match the saved deployment receipt.'
    }
    $settings = Invoke-AzJson @('webapp', 'config', 'appsettings', 'list', '--resource-group', $ResourceGroup, '--name', $AppName)
    $appTenant = ($settings | Where-Object name -eq 'AUTH_TENANT_ID').value
    $storageUrl = ($settings | Where-Object name -eq 'STORAGE_ACCOUNT_URL').value
    if ($appTenant -ne $TenantId) { throw 'The existing app belongs to another configured Entra tenant.' }
    if ($storageUrl -notmatch '^https://([a-z0-9]+)\.blob\.core\.windows\.net/?$') { throw 'The app storage endpoint is not an expected Azure Blob account.' }
    $storageName = $Matches[1]
    $existingStorage = Invoke-AzJson @('storage', 'account', 'show', '--resource-group', $ResourceGroup, '--name', $storageName)
    if ($existingStorage.tags.Workload -ne 'document-review-accelerator') { throw 'The app storage account is not owned by this accelerator deployment.' }
    $networking = @{
        privateNetworking = [bool]$existingApp.virtualNetworkSubnetId
        publicFrontend = $existingApp.publicNetworkAccess -ne 'Disabled'
    }
}
if ($Seed -and -not $networking.publicFrontend) { Write-Host 'Private deployment: the seed caller must be on the connected private network.' }
$operator = Invoke-AzJson @('ad', 'signed-in-user', 'show')
[void](New-Item $local -ItemType Directory -Force)
$api = Ensure-App "$ResourceGroup-api"
$spa = Ensure-App "$ResourceGroup-spa"
$scopeId = 'c97d44b5-9265-4e31-bd99-6328d26212bd'
$reviewerRole = 'eebcbd7d-2b89-47d8-a09c-bf4f479eb0ea'
$importerRole = '757f5768-340d-4c8d-b8bf-33580f875e8a'
$roles = @(
    @{ id = $reviewerRole; allowedMemberTypes = @('User', 'Application'); displayName = 'Reviewer'; description = 'Review source PDFs, record decisions, and sign off cases.'; isEnabled = $true; value = 'Reviewer' },
    @{ id = $importerRole; allowedMemberTypes = @('User', 'Application'); displayName = 'Importer'; description = 'Upload source PDFs and immutable extraction proposals.'; isEnabled = $true; value = 'Importer' }
)
[void](Graph 'PATCH' "applications/$($api.id)" @{
    identifierUris = @("api://$($api.appId)")
    appRoles = $roles
    api = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes = @(@{
            id = $scopeId; value = 'Review.Access'; type = 'Admin'; isEnabled = $true
            adminConsentDisplayName = 'Access document reviews'; adminConsentDescription = 'Access document review operations using assigned application roles.'
        })
    }
    optionalClaims = @{ accessToken = @(@{ name = 'idtyp'; essential = $false }) }
})
[void](Graph 'PATCH' "applications/$($spa.id)" @{
    requiredResourceAccess = @(@{ resourceAppId = $api.appId; resourceAccess = @(@{ id = $scopeId; type = 'Scope' }) })
})
$apiSP = Ensure-SP $api.appId
[void](Ensure-SP $spa.appId)
[void](Graph 'PATCH' "applications/$($api.id)" @{
    api = @{
        preAuthorizedApplications = @(
            @{ appId = $spa.appId; delegatedPermissionIds = @($scopeId) },
            @{ appId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; delegatedPermissionIds = @($scopeId) }
        )
    }
})
[void](Graph 'PATCH' "servicePrincipals/$($apiSP.id)" @{ appRoleAssignmentRequired = $true })
$assignments = Graph 'GET' "servicePrincipals/$($apiSP.id)/appRoleAssignedTo"
foreach ($roleId in @($reviewerRole, $importerRole)) {
    if (-not ($assignments.value | Where-Object { $_.principalId -eq $operator.id -and $_.appRoleId -eq $roleId })) {
        [void](Graph 'POST' "servicePrincipals/$($apiSP.id)/appRoleAssignedTo" @{ principalId = $operator.id; resourceId = $apiSP.id; appRoleId = $roleId })
    }
}
$receipt = [ordered]@{
    schemaVersion = '1.0'; subscriptionId = $SubscriptionId; tenantId = $TenantId; resourceGroup = $ResourceGroup
    namePrefix = $NamePrefix; location = $Location
    apiObjectId = $api.id; apiClientId = $api.appId; spaObjectId = $spa.id; spaClientId = $spa.appId
    apiServicePrincipalId = $apiSP.id; reviewerRoleId = $reviewerRole; importerRoleId = $importerRole
    resourceAppScope = "api://$($api.appId)/Review.Access"; createdAt = [DateTime]::UtcNow.ToString('o')
    privateNetworking = $networking.privateNetworking; publicFrontend = $networking.publicFrontend
}
$receipt | ConvertTo-Json -Depth 10 | Set-Content $receiptPath -Encoding utf8
if ($IdentityOnly) {
    $receipt.location = $existingApp.location
    $receipt.appName = $existingApp.name
    $receipt.appUrl = "https://$($existingApp.defaultHostName)"
    $receipt.storageName = $existingStorage.name
} else {
    Assert-Tenant
    $tags = @("Owner=$($operator.id)", "CostCenter=$CostCenter", "Environment=$Environment", "DataClassification=$DataClassification", 'Workload=document-review-accelerator')
    if ($KeepDemoRunning) { $tags += 'CostControl=Ignore' }
    $groupLocation = if ($groupExists) { $existingGroup.location } else { $Location }
    [void](Invoke-AzJson (@('group', 'create', '--name', $ResourceGroup, '--location', $groupLocation, '--tags') + $tags))
    $deployment = Invoke-AzJson @(
        'deployment', 'group', 'create', '--resource-group', $ResourceGroup, '--name', 'document-review',
        '--template-file', (Join-Path $root 'infra\main.bicep'), '--parameters',
        "namePrefix=$NamePrefix", "location=$Location", "tenantId=$TenantId", "apiClientId=$($api.appId)",
        "spaClientId=$($spa.appId)", "owner=$($operator.id)", "costCenter=$CostCenter",
        "environment=$Environment", "dataClassification=$DataClassification",
        "privateNetworking=$($networking.privateNetworking.ToString().ToLowerInvariant())",
        "publicFrontend=$($networking.publicFrontend.ToString().ToLowerInvariant())",
        "keepDemoRunning=$($KeepDemoRunning.IsPresent.ToString().ToLowerInvariant())"
    )
    $outputs = $deployment.properties.outputs
    $receipt.appName = $outputs.appName.value
    $receipt.appUrl = $outputs.appUrl.value
    $receipt.storageName = $outputs.storageName.value
    $receipt.privateNetworking = $outputs.privateNetworking.value
    $receipt.publicFrontend = $outputs.publicFrontend.value
}
$receipt | ConvertTo-Json -Depth 10 | Set-Content $receiptPath -Encoding utf8
[void](Graph 'PATCH' "applications/$($spa.id)" @{ spa = @{ redirectUris = @("$($receipt.appUrl)/auth.html", 'http://localhost:8080/auth.html') } })
Push-Location $root
try {
    if (-not $IdentityOnly -or $Seed) {
        & npm ls --omit=dev --depth=0
        if ($LASTEXITCODE -ne 0) {
            & npm ci --ignore-scripts --omit=optional --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw 'Dependency restore failed.' }
        }
    }
    Assert-Tenant
    if ($IdentityOnly) {
        [void](Invoke-AzJson @('webapp', 'config', 'appsettings', 'set', '--resource-group', $ResourceGroup, '--name', $receipt.appName,
            '--settings', "AUTH_TENANT_ID=$TenantId", "AUTH_API_CLIENT_ID=$($api.appId)", "AUTH_SPA_CLIENT_ID=$($spa.appId)"))
    } else {
        & (Join-Path $PSScriptRoot 'package.ps1')
        [void](Invoke-AzJson @('webapp', 'deploy', '--resource-group', $ResourceGroup, '--name', $receipt.appName,
            '--src-path', (Join-Path $root 'dist\app.zip'), '--type', 'zip', '--clean', 'true', '--restart', 'true', '--timeout', '600000'))
    }
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod "$($receipt.appUrl)/healthz" -TimeoutSec 15
            $ready = Invoke-RestMethod "$($receipt.appUrl)/api/config" -TimeoutSec 15
            if ($health.status -eq 'ok' -and $health.component -eq 'document-review' -and
                $ready.mode -eq 'connected' -and $ready.spaClientId -eq $spa.appId -and $ready.apiScope -eq $receipt.resourceAppScope) {
                $healthy = $true
                break
            }
        } catch { }
        Start-Sleep 5
    }
    if (-not $healthy) { throw 'Deployment did not become healthy. Inspect App Service logs; do not treat deployment status as application success.' }
    if ($Seed) {
        Assert-Tenant
        $access = Invoke-AzJson @('account', 'get-access-token', '--scope', $receipt.resourceAppScope)
        try {
            $env:DOCUMENT_REVIEW_TOKEN = $access.accessToken
            & node (Join-Path $PSScriptRoot 'seed.mjs') $receipt.appUrl
            if ($LASTEXITCODE -ne 0) { throw 'Synthetic seed verification failed.' }
        } finally { Remove-Item Env:\DOCUMENT_REVIEW_TOKEN -ErrorAction SilentlyContinue; $access = $null }
    }
} finally { Pop-Location }
$receipt.deployedAt = [DateTime]::UtcNow.ToString('o')
$receipt | ConvertTo-Json -Depth 10 | Set-Content $receiptPath -Encoding utf8
Write-Host "Deployed: $($receipt.appUrl)"
Write-Host "Receipt (no credentials): $receiptPath"
