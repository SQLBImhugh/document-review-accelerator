targetScope = 'resourceGroup'

@minLength(3)
@maxLength(30)
@description('Lowercase name prefix. Use a new, empty resource group for the portal deployment.')
param namePrefix string = 'docreview'
@description('Optional Azure region code. Leave blank to use the resource group location.')
param location string = ''
@minLength(1)
@description('Resource owner alias or team for tagging.')
param owner string
param costCenter string = 'POC'
param environment string = 'POC'
param dataClassification string = 'Synthetic'

var version = loadJsonContent('../package.json', 'version')
var packageUri = 'https://github.com/SQLBImhugh/document-review-accelerator/releases/download/v${version}/document-review-app-v${version}.zip'

resource groupTags 'Microsoft.Resources/tags@2021-04-01' = {
  name: 'default'
  properties: {
    tags: union(resourceGroup().tags, {
      Owner: owner
      CostCenter: costCenter
      Environment: environment
      DataClassification: dataClassification
      Workload: 'document-review-accelerator'
    })
  }
}
module workbench './main.bicep' = {
  name: 'document-review-workbench'
  params: {
    namePrefix: namePrefix
    location: empty(location) ? resourceGroup().location : location
    tenantId: tenant().tenantId
    owner: owner
    costCenter: costCenter
    environment: environment
    dataClassification: dataClassification
    privateNetworking: false
    publicFrontend: true
    appPackageUri: packageUri
  }
  dependsOn: [groupTags]
}
output appName string = workbench.outputs.appName
output appUrl string = workbench.outputs.appUrl
output storageName string = workbench.outputs.storageName
output identitySetupCommand string = '.\\scripts\\deploy.ps1 -SubscriptionId "${subscription().subscriptionId}" -TenantId "${tenant().tenantId}" -ResourceGroup "${resourceGroup().name}" -AppName "${workbench.outputs.appName}" -IdentityOnly'
output nextStep string = 'Run identitySetupCommand from a checkout of this repository. Review APIs stay locked until Microsoft Entra setup is complete.'
