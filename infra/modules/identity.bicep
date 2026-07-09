@description('Name of the user-assigned managed identity shared by the Saleor container apps/jobs.')
param name string

@description('Azure region for the identity.')
param location string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
}

output id string = identity.id
output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
