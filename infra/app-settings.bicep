targetScope = 'resourceGroup'

param appName string
@secure()
param settings object

resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  name: '${appName}/appsettings'
  properties: settings
}
