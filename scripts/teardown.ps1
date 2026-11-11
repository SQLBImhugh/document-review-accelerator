[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ReceiptPath,
    [Parameter(Mandatory)][string]$ConfirmResourceGroup
)
$ErrorActionPreference = 'Stop'
$receipt = Get-Content -Raw -LiteralPath $ReceiptPath | ConvertFrom-Json
if ($receipt.schemaVersion -ne '1.0' -or $ConfirmResourceGroup -ne $receipt.resourceGroup) { throw 'The exact recorded resource group name is required.' }
& az account set --subscription $receipt.subscriptionId --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Subscription selection failed.' }
$account = (& az account show --only-show-errors -o json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $account.id -ne $receipt.subscriptionId -or $account.tenantId -ne $receipt.tenantId) { throw 'Wrong subscription or tenant.' }
$group = (& az group show --name $receipt.resourceGroup --only-show-errors -o json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $group.tags.Workload -ne 'document-review-accelerator') { throw 'The resource group does not have the accelerator ownership tag.' }
foreach ($objectId in @($receipt.spaObjectId, $receipt.apiObjectId)) {
    $app = (& az ad app show --id $objectId --only-show-errors -o json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $app.tags -notcontains "document-review-accelerator:$($receipt.resourceGroup)") { throw 'An application ownership tag does not match the recorded deployment.' }
}
if ($PSCmdlet.ShouldProcess("$($receipt.resourceGroup) and its two Entra registrations", 'Delete all accelerator resources and stored reviews')) {
    & az account set --subscription $receipt.subscriptionId --only-show-errors
    $current = (& az account show --only-show-errors -o json) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $current.id -ne $receipt.subscriptionId -or $current.tenantId -ne $receipt.tenantId) { throw 'Azure context changed before deletion.' }
    & az group delete --name $receipt.resourceGroup --yes --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Resource group deletion failed. Registrations have been retained.' }
    foreach ($objectId in @($receipt.spaObjectId, $receipt.apiObjectId)) {
        & az ad app delete --id $objectId --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw "Application deletion failed: $objectId" }
    }
    Write-Host 'Accelerator resources and recorded registrations deleted.'
}
