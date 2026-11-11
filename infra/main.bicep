targetScope = 'resourceGroup'

@minLength(3)
@maxLength(30)
param namePrefix string = 'docreview'
param location string = resourceGroup().location
param tenantId string = tenant().tenantId
param apiClientId string = ''
param spaClientId string = ''
param owner string
param costCenter string = 'POC'
param environment string = 'POC'
param dataClassification string = 'Synthetic'
@description('Opt in to a VNet, private Blob endpoint, and private DNS. The default uses public endpoints with Entra authentication.')
param privateNetworking bool = false
@description('With private networking, expose only the Entra-protected web frontend. Otherwise the frontend is public by default.')
param publicFrontend bool = false
@description('Use only where the documented tenant cost-control exemption is approved.')
param keepDemoRunning bool = false
@description('Optional public HTTPS ZIP package. Leave blank when publishing code separately with the CLI.')
param appPackageUri string = ''

var suffix = uniqueString(resourceGroup().id)
var enablePublicFrontend = !privateNetworking || publicFrontend
var tags = union({
  Owner: owner
  CostCenter: costCenter
  Environment: environment
  DataClassification: dataClassification
  Workload: 'document-review-accelerator'
  DeploymentPrefix: namePrefix
}, keepDemoRunning ? { CostControl: 'Ignore' } : {})

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = if (privateNetworking) {
  name: '${namePrefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.74.0.0/24'] }
    subnets: [
      {
        name: 'app'
        properties: {
          addressPrefix: '10.74.0.0/26'
          defaultOutboundAccess: false
          delegations: [
            { name: 'web', properties: { serviceName: 'Microsoft.Web/serverFarms' } }
          ]
        }
      }
      {
        name: 'endpoints'
        properties: {
          addressPrefix: '10.74.0.64/27'
          defaultOutboundAccess: false
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'dr${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    publicNetworkAccess: privateNetworking ? 'Disabled' : 'Enabled'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    networkAcls: { defaultAction: privateNetworking ? 'Deny' : 'Allow', bypass: 'None' }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: { blob: { enabled: true }, file: { enabled: true } }
    }
  }
}
resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}
resource reviews 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'review'
  properties: { publicAccess: 'None' }
}
resource documents 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'documents'
  properties: { publicAccess: 'None' }
}
resource blobDns 'Microsoft.Network/privateDnsZones@2024-06-01' = if (privateNetworking) {
  name: 'privatelink.blob.${az.environment().suffixes.storage}'
  location: 'global'
  tags: tags
}
resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (privateNetworking) {
  parent: blobDns
  name: '${namePrefix}-blob-link'
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: network!.id } }
}
resource blobEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateNetworking) {
  name: '${namePrefix}-blob-pe'
  location: location
  tags: tags
  properties: {
    subnet: { id: resourceId('Microsoft.Network/virtualNetworks/subnets', network!.name, 'endpoints') }
    privateLinkServiceConnections: [
      { name: 'blob', properties: { privateLinkServiceId: storage.id, groupIds: ['blob'] } }
    ]
  }
}
resource blobZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateNetworking) {
  parent: blobEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: blobDns!.id } }]
  }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${namePrefix}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: 'B1', tier: 'Basic', capacity: 1 }
  properties: { reserved: true }
}
resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: '${namePrefix}-${suffix}'
  location: location
  tags: tags
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: enablePublicFrontend ? 'Enabled' : 'Disabled'
    virtualNetworkSubnetId: privateNetworking ? resourceId('Microsoft.Network/virtualNetworks/subnets', network!.name, 'app') : null
    vnetRouteAllEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server/index.mjs'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      http20Enabled: true
      healthCheckPath: '/healthz'
    }
  }
}
module appSettings './app-settings.bicep' = {
  name: '${namePrefix}-app-settings'
  params: {
    appName: app.name
    // Read outside the child deployment to avoid an appsettings self-dependency.
    settings: union(
      list('${app.id}/config/appsettings', '2024-04-01').properties ?? {},
      {
        NODE_ENV: 'production'
        AUTH_TENANT_ID: tenantId
        STORAGE_ACCOUNT_URL: storage.properties.primaryEndpoints.blob
        SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
        ENABLE_ORYX_BUILD: 'false'
        WEBSITE_RUN_FROM_PACKAGE: '1'
      },
      empty(apiClientId) ? {} : { AUTH_API_CLIENT_ID: apiClientId },
      empty(spaClientId) ? {} : { AUTH_SPA_CLIENT_ID: spaClientId }
    )
  }
}
resource scmPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: app
  name: 'scm'
  properties: { allow: false }
}
resource ftpPolicy 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}
resource dataRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, 'blob-contributor')
  scope: storage
  properties: {
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}
resource code 'Microsoft.Web/sites/extensions@2021-03-01' = if (!empty(appPackageUri)) {
  parent: app
  name: 'onedeploy'
  // The published OneDeploy type omits the package properties supported by App Service.
  #disable-next-line BCP187
  properties: {
    packageUri: appPackageUri
    type: 'zip'
  }
  dependsOn: [appSettings, scmPolicy, ftpPolicy, dataRole, reviews, documents]
}
resource appDns 'Microsoft.Network/privateDnsZones@2024-06-01' = if (privateNetworking && !enablePublicFrontend) {
  name: 'privatelink.azurewebsites.net'
  location: 'global'
  tags: tags
}
resource appDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (privateNetworking && !enablePublicFrontend) {
  parent: appDns
  name: '${namePrefix}-app-link'
  location: 'global'
  tags: tags
  properties: { registrationEnabled: false, virtualNetwork: { id: network!.id } }
}
resource appEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (privateNetworking && !enablePublicFrontend) {
  name: '${namePrefix}-app-pe'
  location: location
  tags: tags
  properties: {
    subnet: { id: resourceId('Microsoft.Network/virtualNetworks/subnets', network!.name, 'endpoints') }
    privateLinkServiceConnections: [
      { name: 'app', properties: { privateLinkServiceId: app.id, groupIds: ['sites'] } }
    ]
  }
}
resource appZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (privateNetworking && !enablePublicFrontend) {
  parent: appEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [{ name: 'app', properties: { privateDnsZoneId: appDns!.id } }]
  }
}
output appName string = app.name
output appId string = app.id
output appUrl string = 'https://${app.properties.defaultHostName}'
output storageName string = storage.name
output storageId string = storage.id
output privateNetworking bool = privateNetworking
output publicFrontend bool = enablePublicFrontend
output managedIdentityId string = app.identity.principalId
