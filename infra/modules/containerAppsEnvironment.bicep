@description('Name of the Container Apps managed environment.')
param name string

@description('Azure region for the environment.')
param location string

@description('Log Analytics workspace customer ID.')
param logAnalyticsCustomerId string

@description('Log Analytics workspace shared key.')
@secure()
param logAnalyticsSharedKey string

resource environment 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: name
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: logAnalyticsSharedKey
      }
    }
  }
}

output id string = environment.id
output defaultDomain string = environment.properties.defaultDomain
